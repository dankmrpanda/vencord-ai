/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from '@webpack/common';

/** Inline 24-unit SVG icons drawn in currentColor, sized like Discord's own toolbar icons. */
type IconProps = { size?: number; className?: string };

const svg = (paths: React.ReactNode, { size = 20, className }: IconProps, filled = false) => (
  <svg
    className={className}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={filled ? 'currentColor' : 'none'}
    stroke={filled ? 'none' : 'currentColor'}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {paths}
  </svg>
);

export const SparkleIcon = (p: IconProps) => svg(
  <>
    <path d="M12 2.5c.4 3.9 1.7 6.6 3.4 8.1 1.6 1.4 3.8 2.1 6.1 2.4-2.3.3-4.5 1-6.1 2.4-1.7 1.5-3 4.2-3.4 8.1-.4-3.9-1.7-6.6-3.4-8.1C7 14 4.8 13.3 2.5 13c2.3-.3 4.5-1 6.1-2.4C10.3 9.1 11.6 6.4 12 2.5Z" />
  </>, p, true);
export const NewChatIcon = (p: IconProps) => svg(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>, p);
export const HistoryIcon = (p: IconProps) => svg(<><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></>, p);
export const SettingsIcon = (p: IconProps) => svg(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </>, p);
export const CloseIcon = (p: IconProps) => svg(<><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>, p);
export const BugIcon = (p: IconProps) => svg(
  <>
    <rect x="8" y="6" width="8" height="14" rx="4" />
    <path d="M19 7l-3 2M5 7l3 2M19 13h-3M5 13h3M19 19l-3-2M5 19l3-2M12 6V3M9 3.5l1.5 2M15 3.5l-1.5 2" />
  </>, p);
export const SendIcon = (p: IconProps) => svg(<><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></>, p);
export const StopIcon = (p: IconProps) => svg(<rect x="6" y="6" width="12" height="12" rx="2" />, p, true);
export const ChevronDownIcon = (p: IconProps) => svg(<path d="m6 9 6 6 6-6" />, p);
export const ChevronRightIcon = (p: IconProps) => svg(<path d="m9 6 6 6-6 6" />, p);
export const CopyIcon = (p: IconProps) => svg(<><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>, p);
export const CheckIcon = (p: IconProps) => svg(<path d="M20 6 9 17l-5-5" />, p);
export const RetryIcon = (p: IconProps) => svg(<><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></>, p);
export const TrashIcon = (p: IconProps) => svg(<><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></>, p);
export const ArrowDownIcon = (p: IconProps) => svg(<><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></>, p);
export const HashIcon = (p: IconProps) => svg(<><path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" /></>, p);
export const AtIcon = (p: IconProps) => svg(<><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" /></>, p);
export const UsersIcon = (p: IconProps) => svg(<><circle cx="9" cy="8" r="4" /><path d="M2 21a7 7 0 0 1 14 0" /><path d="M16 3.1a4 4 0 0 1 0 7.8M22 21a7 7 0 0 0-4.5-6.5" /></>, p);
export const ServerIcon = (p: IconProps) => svg(<><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20" /></>, p);
export const SearchIcon = (p: IconProps) => svg(<><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>, p);
export const MessagesIcon = (p: IconProps) => svg(<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />, p);
export const ImageIcon = (p: IconProps) => svg(<><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></>, p);
export const FileIcon = (p: IconProps) => svg(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /></>, p);
export const LinkIcon = (p: IconProps) => svg(<><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></>, p);
export const PinIcon = (p: IconProps) => svg(<><path d="M12 17v5" /><path d="M9 10.8V4h6v6.8l3 3.2v1H6v-1Z" /></>, p);
export const ThreadIcon = (p: IconProps) => svg(<><path d="M4 6h16M4 12h10M4 18h7" /></>, p);
export const CompassIcon = (p: IconProps) => svg(<><circle cx="12" cy="12" r="10" /><path d="m16 8-2 6-6 2 2-6Z" /></>, p);
export const WarningIcon = (p: IconProps) => svg(<><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></>, p);
export const JumpIcon = (p: IconProps) => svg(<><path d="M7 17 17 7" /><path d="M7 7h10v10" /></>, p);
export const MicIcon = (p: IconProps) => svg(<><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0" /><path d="M12 17v4" /></>, p);
export const ToolIcon = (p: IconProps) => svg(<path d="M14.7 6.3a4 4 0 0 0 5 5L22 14l-8 8-2.3-2.3a4 4 0 0 0-5-5L4 12l8-8Z" />, p);

/** The icon a tool step is drawn with. */
export function toolIcon(toolName: string | undefined): React.ReactNode {
  switch (toolName) {
    case 'search_messages': return <SearchIcon size={14} />;
    case 'fetch_recent_messages':
    case 'fetch_surrounding_messages':
    case 'get_message_details': return <MessagesIcon size={14} />;
    case 'inspect_image': return <ImageIcon size={14} />;
    case 'transcribe_voice_message': return <MicIcon size={14} />;
    case 'list_channel_pins': return <PinIcon size={14} />;
    case 'list_threads': return <ThreadIcon size={14} />;
    case 'list_available_channels':
    case 'get_current_context': return <CompassIcon size={14} />;
    default: return <ToolIcon size={14} />;
  }
}
