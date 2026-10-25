import { terminalConnectionState } from './terminalStatus.mjs';

export type TerminalStatusRecord = {
  terminal_id: string;
  name: string;
  status: 'active' | 'revoked';
  last_seen_at: string | null;
};

type Props = {
  terminals: TerminalStatusRecord[];
  disabled: boolean;
  onRevoke: (terminal: TerminalStatusRecord) => void;
};

const labels = { online: 'Online', offline: 'Offline', never: 'Never connected', revoked: 'Revoked' } as const;
const dotColors = {
  online: 'bg-[#55a877]',
  offline: 'bg-[#c16a52]',
  never: 'bg-[#d2a54f]',
  revoked: 'bg-[#aab2ac]',
} as const;

export default function TerminalStatusList({ terminals, disabled, onRevoke }: Props) {
  if (!terminals.length) return null;

  return <div className="mt-5 border-t border-[#edf0ed] pt-4">
    <h3 className="text-xs font-semibold text-[#526259]">Enrolled terminals</h3>
    <ul className="mt-2 space-y-2">
      {terminals.map(terminal => {
        const state = terminalConnectionState(terminal.status, terminal.last_seen_at);
        return <li key={terminal.terminal_id} className="flex items-center gap-2 rounded-lg bg-[#f7f9f7] p-2.5">
          <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${dotColors[state]}`} />
          <span className="min-w-0 flex-1">
            <strong className="block truncate text-xs text-[#405149]">{terminal.name}</strong>
            <small className="block truncate text-[10px] text-[#68776d]">
              <span className="font-semibold">{labels[state]}</span>
              {terminal.last_seen_at && state !== 'revoked' ? ` · Last seen ${new Date(terminal.last_seen_at).toLocaleString('en-IN')}` : ''}
              {' · '}{terminal.terminal_id}
            </small>
          </span>
          {terminal.status === 'active' && <button type="button" disabled={disabled} onClick={() => onRevoke(terminal)} className="rounded-md border border-[#ecdcd7] bg-white px-2 py-1.5 text-[10px] font-semibold text-[#a65340] disabled:opacity-50">Revoke</button>}
        </li>;
      })}
    </ul>
  </div>;
}
