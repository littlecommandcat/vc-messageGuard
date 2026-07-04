/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2026 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { updateMessage } from "@api/MessageUpdater";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Message } from "@vencord/discord-types";
import { FluxDispatcher, Menu, MessageStore, SelectedChannelStore, ChannelStore, GuildStore, UserStore } from "@webpack/common";

const PLUGIN_NAME = "MessageGuard";
const LOGGER = new Logger(PLUGIN_NAME);
const UPDATE_PER = 5_000;

interface MGMessage extends Message {
    mgBlocked?: boolean;
    mgReason?: string;
}

interface TempBlockEntry {
    expiresAt: number;
    reason: string;
    channelIds: Set<string>;
}

interface TimedEntry { timestamp: number; messageId: string; }

const tempBlockedUsers = new Map<string, TempBlockEntry>();
const authorTimestamps = new Map<string, TimedEntry[]>();

let enabled = false;
let interceptorAdded = false;
let cleanupInterval: ReturnType<typeof setInterval> | undefined;

function getKeywords(): string[] {
    return (settings.store.blockedKeywords ?? "")
        .split(",")
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
}

function matchesKeyword(content: string | undefined): boolean {
    if (!settings.store.enableKeywordFilter)
        return false;
    if (!content)
        return false;
    const lower = content.toLowerCase();
    return getKeywords().some(k => lower.includes(k));
}

function isUserTempBlocked(userId: string): boolean {
    const entry = tempBlockedUsers.get(userId);
    if (!entry) return false;
    if (entry.expiresAt <= Date.now()) {
        for (const cid of entry.channelIds) flagAuthorMessagesInChannel(cid, userId, false);
        tempBlockedUsers.delete(userId);
        return false;
    }
    return true;
}

function flagAuthorMessagesInChannel(channelId: string | null | undefined, authorId: string, value: boolean) {
    if (!channelId) return;
    const messages = MessageStore.getMessages(channelId) as MGMessage[] | undefined;
    messages?.forEach(m => {
        if (m.author?.id === authorId && m.mgBlocked !== value) {
            updateMessage(channelId, m.id, { mgBlocked: value } as any);
        }
    });
}

function tempBlockUser(userId: string, reason: string, channelId?: string) {
    if (!userId || userId === UserStore.getCurrentUser()?.id) return;
    const minutes = Math.max(10, Number(settings.store.tempBlockDuration) || 10);

    const existing = tempBlockedUsers.get(userId);
    const channelIds = existing?.channelIds ?? new Set<string>();
    if (channelId)
        channelIds.add(channelId);

    tempBlockedUsers.set(userId, {
        expiresAt: Date.now() + minutes * 60_000,
        reason,
        channelIds
    });
    const username = UserStore.getUser(userId)?.username || "Unknown";
    LOGGER.info(`Temporary block user ${username}(${userId}) (Reason: ${reason}, length: ${minutes} Minutes)`);

    for (const cid of channelIds) flagAuthorMessagesInChannel(cid, userId, true);
}

function manualUnblockUser(userId: string) {
    const entry = tempBlockedUsers.get(userId);
    if (entry) for (const cid of entry.channelIds) flagAuthorMessagesInChannel(cid, userId, false);
    tempBlockedUsers.delete(userId);
    const username = UserStore.getUser(userId)?.username || "Unknown";
    LOGGER.info(`Unblock user ${username}(${userId})`);
}

function checkFlood(channelId: string, authorId: string, messageId: string, timestamp: number): boolean {
    if (!settings.store.enableFloodDetection) return false;
    const key = `${channelId}:${authorId}`;
    const windowMs = Math.max(200, Number(settings.store.floodTimeWindow) || 3000);
    const threshold = Math.max(2, Number(settings.store.floodMessageCount) || 5);

    const list = (authorTimestamps.get(key) ?? []).filter(e => timestamp - e.timestamp <= windowMs);
    list.push({ timestamp, messageId });
    authorTimestamps.set(key, list);

    if (list.length >= threshold) {
        tempBlockUser(authorId, "User spaming", channelId);
        return true;
    }
    return false;
}

const settings = definePluginSettings({
    enableKeywordFilter: {
        type: OptionType.BOOLEAN,
        description: "Enable keywords blocking",
        default: true
    },
    blockedKeywords: {
        type: OptionType.STRING,
        description: "Block keywords (split with `,`)",
        default: ""
    },
    enableFloodDetection: {
        type: OptionType.BOOLEAN,
        description: "Enable spaming detecting",
        default: true
    },
    floodMessageCount: {
        type: OptionType.NUMBER,
        description: "Spaming amount",
        default: 5
    },
    floodTimeWindow: {
        type: OptionType.NUMBER,
        description: "Spaming time(ms)",
        default: 1500
    },
    tempBlockDuration: {
        type: OptionType.NUMBER,
        description: "Auto/Temporary blocking user time(minutes)",
        default: 10
    }
});

const userContextPatch: NavContextMenuPatchCallback = (children, { user }: { user?: { id: string; }; }) => {
    if (!user || user.id === UserStore.getCurrentUser()?.id) return;
    const blocked = isUserTempBlocked(user.id);
    children.push(
        <Menu.MenuItem
            id="message-guard-temp-block"
            label={blocked ? `Cancel Blocking (${PLUGIN_NAME})` : `Temporary Block (${PLUGIN_NAME})`}
            action={() => {
                if (blocked) {
                    manualUnblockUser(user.id);
                } else {
                    const channelId = SelectedChannelStore.getChannelId();
                    tempBlockUser(user.id, "Block user", channelId ?? undefined);
                }
            }}
        />
    );
};


function fluxInterceptor(event: any): boolean {
    if (!enabled) return false;

    if (event?.type === "TYPING_START") {
        return !!(event.userId && isUserTempBlocked(event.userId));
    }

    if (event?.type !== "MESSAGE_CREATE") return false;

    const message = event.message as MGMessage;
    const authorId = message?.author?.id;
    if (!message?.id || !authorId || authorId === UserStore.getCurrentUser()?.id) return false;

    const channelId: string = message.channel_id ?? (message as any).channelId;
    const channel = ChannelStore.getChannel(channelId);
    const channelName = channel?.name || "Unknown";

    const guildId = channel?.guild_id;
    const guildName = guildId ? (GuildStore.getGuild(guildId)?.name || "Unknown") : "Unknown";

    const now = Date.now();
    let blocked = false;

    if (matchesKeyword(message.content)) {
        blocked = true;
        const shortContent = message.content.slice(0, 50);
        LOGGER.info(`Matches keyword in ${shortContent} at guild: ${guildName}, channel: #${channelName}`);
    }

    if (isUserTempBlocked(authorId) || checkFlood(channelId, authorId, message.id, now)) {
        blocked = true;
    }

    if (blocked) {
        message.mgBlocked = true;
    }

    return false;
}

export default definePlugin({
    name: PLUGIN_NAME,
    description: "Block user spaming, keywords, and temporary blocking",
    authors: [Devs?.commandcat ?? { name: "command_cat", id: 1058383460043083787n }],
    settings,

    contextMenus: {
        "user-context": userContextPatch
    },

    start() {
        enabled = true;
        if (!interceptorAdded) {
            FluxDispatcher.addInterceptor(fluxInterceptor);
            interceptorAdded = true;
        }

        cleanupInterval = setInterval(() => {
            const now = Date.now();
            for (const [userId, entry] of tempBlockedUsers) {
                if (entry.expiresAt <= now) {
                    for (const cid of entry.channelIds) flagAuthorMessagesInChannel(cid, userId, false);
                    tempBlockedUsers.delete(userId);
                }
            }
        }, UPDATE_PER);

        LOGGER.info("Loaded.");
    },

    stop() {
        enabled = false;
        if (cleanupInterval) clearInterval(cleanupInterval);

        tempBlockedUsers.clear();
        authorTimestamps.clear();

        LOGGER.info("Unloaded.");
    },

    patches: [
        {
            find: "}addReaction(",
            replacement: {
                match: /this\.customRenderedContent=(\i)\.customRenderedContent,/,
                replace: "this.customRenderedContent=$1.customRenderedContent,this.mgBlocked=$1.mgBlocked||false,"
            }
        },
        {
            find: "NON_COLLAPSIBLE.has(",
            replacement: {
                match: /if\((\i)\.blocked\)return (\i\.\i\.MESSAGE_GROUP_BLOCKED);/,
                replace: "if($1.blocked||$1.mgBlocked)return $2;"
            }
        }
    ]
});