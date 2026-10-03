import type { DeliveredAttachment } from '../../../shared/types';
import { fmtBytes } from '../util';
import { Icon } from './ui';

/** Where an attachment downloads from (always as a file, never shown in the page: docs/attachments.md). */
export const attachmentUrl = (id: string) => `/api/attachments/${encodeURIComponent(id)}/download`;

/**
 * The files that came with a message (docs/attachments.md), each a download link with its size; the tooltip has its
 * kind, id and SHA-256, and, when the agent did not get its copy, why.
 */
export function AttachmentList({ items }: { items: DeliveredAttachment[] }) {
  return (
    <div className="attach-list">
      {items.map((a) => (
        <a
          key={a.id}
          className={`attach-chip${a.error ? ' failed' : ''}`}
          href={attachmentUrl(a.id)}
          download={a.name}
          title={[a.kind, a.id, `sha256 ${a.sha256}`, a.error ? `Not delivered: ${a.error}` : ''].filter(Boolean).join('\n')}
          data-testid="attachment"
        >
          <Icon name="file" size={14} />
          <span className="attach-name">{a.name}</span>
          <span className="attach-size">{a.error ? 'not delivered' : fmtBytes(a.size)}</span>
          <Icon name="download" size={13} />
        </a>
      ))}
    </div>
  );
}
