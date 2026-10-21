// The machine control: a switcher, one chip per machine, because there are
// only ever a handful and a drop-down would hide them. The selected machine
// carries the accent fill; an offline one is visible but not selectable. No
// tooltips — the chip reads the machine's name and nothing hides behind it.
//
// "Machine" is the word the UI uses for what the protocol calls a host
// (spec/14 § Copy).

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
      aria-label="Machine"
      data-testid={testId}
      data-selected={selected ?? undefined}
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
          onClick={() => onSelect(h.hostId)}
        >
          {h.label}
          {h.online ? null : ' · offline'}
        </button>
      ))}
    </div>
  );
}
