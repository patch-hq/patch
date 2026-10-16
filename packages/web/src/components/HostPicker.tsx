// The host (machine) control: a switcher, one button per host, because there
// are only ever a handful and a drop-down would hide them. The selected host
// carries the accent fill; an offline one is visible but not selectable.

export interface HostPickerOption {
  hostId: string;
  label: string;
  online: boolean;
}

interface HostPickerProps {
  hosts: HostPickerOption[];
  selected: string | null;
  onSelect: (hostId: string) => void;
  testId: string;
}

export function HostPicker({ hosts, selected, onSelect, testId }: HostPickerProps): JSX.Element {
  return (
    <div
      className="new-chat-quick"
      role="radiogroup"
      aria-label="host"
      data-testid={testId}
      title={selected ?? undefined}
    >
      {hosts.map((h) => (
        <button
          key={h.hostId}
          type="button"
          role="radio"
          className={`folder-quick ${h.hostId === selected ? 'selected' : ''}`}
          data-testid={`host-option-${h.hostId}`}
          aria-checked={h.hostId === selected}
          disabled={!h.online}
          title={h.online ? h.hostId : `${h.hostId} · offline`}
          onClick={() => onSelect(h.hostId)}
        >
          {h.label}
          {h.online ? null : ' · offline'}
        </button>
      ))}
    </div>
  );
}
