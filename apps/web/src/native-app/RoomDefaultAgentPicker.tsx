import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export interface RoomDefaultAgentOption {
  id: string;
  label: string;
  disabled?: boolean;
}

export interface RoomDefaultAgentPickerProps {
  ariaLabel: string;
  avatarLabel: string;
  disabled?: boolean;
  label: string;
  onSelect: (agentId: string) => void;
  options: readonly RoomDefaultAgentOption[];
  status?: ReactNode;
  value?: string;
}

function firstEnabledOptionIndex(options: readonly RoomDefaultAgentOption[]): number {
  return options.findIndex((option) => !option.disabled);
}

function selectedOrFirstEnabledOptionIndex(
  options: readonly RoomDefaultAgentOption[],
  value?: string
): number {
  const selectedIndex = options.findIndex((option) => option.id === value && !option.disabled);
  return selectedIndex >= 0 ? selectedIndex : firstEnabledOptionIndex(options);
}

/** Resolve the next enabled item without wrapping through disabled options. */
export function roomDefaultAgentPickerNextIndex(
  options: readonly RoomDefaultAgentOption[],
  currentIndex: number,
  direction: -1 | 1
): number {
  if (!options.length) return -1;
  const start = currentIndex >= 0 && currentIndex < options.length ? currentIndex : (direction > 0 ? -1 : options.length);
  for (let offset = 1; offset <= options.length; offset += 1) {
    const index = (start + (direction * offset) + options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return currentIndex;
}

function RoomChevronIcon(): ReactNode {
  return (
    <svg className="native-work-composer-chevron" data-icon="chevron-down" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="m2.5 4.5 3.5 3 3.5-3" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.25" />
    </svg>
  );
}

export function RoomDefaultAgentPicker({
  ariaLabel,
  avatarLabel,
  disabled = false,
  label,
  onSelect,
  options,
  status,
  value
}: RoomDefaultAgentPickerProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() => selectedOrFirstEnabledOptionIndex(options, value));
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const typeaheadRef = useRef<{ query: string; timer?: number }>({ query: "" });
  const menuId = useId();
  const optionSignature = options.map((option) => `${option.id}:${option.disabled ? "disabled" : "enabled"}`).join("\n");
  const hasEnabledOption = options.some((option) => !option.disabled);
  const triggerDisabled = disabled || !hasEnabledOption;

  useEffect(() => {
    setActiveIndex(selectedOrFirstEnabledOptionIndex(options, value));
    setOpen(false);
  }, [optionSignature, value]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const frame = window.requestAnimationFrame(() => optionRefs.current[activeIndex]?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [activeIndex, open]);

  useEffect(() => () => {
    if (typeaheadRef.current.timer !== undefined) window.clearTimeout(typeaheadRef.current.timer);
  }, []);

  const closeMenu = (restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  const focusOption = (index: number): void => {
    if (index < 0) return;
    setActiveIndex(index);
    optionRefs.current[index]?.focus();
  };

  const openMenu = (): void => {
    if (triggerDisabled) return;
    setActiveIndex(selectedOrFirstEnabledOptionIndex(options, value));
    setOpen(true);
  };

  const commitOption = (index: number): void => {
    const option = options[index];
    if (!option || option.disabled) return;
    closeMenu(true);
    if (option.id !== value) onSelect(option.id);
  };

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    openMenu();
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === "Tab") {
      closeMenu(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusOption(roomDefaultAgentPickerNextIndex(options, activeIndex, event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const index = event.key === "Home" ? firstEnabledOptionIndex(options) : [...options].map((option, index) => option.disabled ? -1 : index).reverse().find((index) => index >= 0) ?? -1;
      focusOption(index);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commitOption(activeIndex);
      return;
    }
    if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;

    const query = `${typeaheadRef.current.query}${event.key}`.toLocaleLowerCase();
    const matchIndex = options.findIndex((option) => !option.disabled && option.label.toLocaleLowerCase().startsWith(query));
    const fallbackIndex = matchIndex >= 0
      ? matchIndex
      : options.findIndex((option) => !option.disabled && option.label.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()));
    if (fallbackIndex >= 0) focusOption(fallbackIndex);
    typeaheadRef.current.query = matchIndex >= 0 ? query : event.key.toLocaleLowerCase();
    if (typeaheadRef.current.timer !== undefined) window.clearTimeout(typeaheadRef.current.timer);
    typeaheadRef.current.timer = window.setTimeout(() => {
      typeaheadRef.current.query = "";
      typeaheadRef.current.timer = undefined;
    }, 700);
  };

  return (
    <div ref={rootRef} className="native-work-agent-picker">
      <button
        ref={triggerRef}
        type="button"
        className="native-work-agent-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        disabled={triggerDisabled}
        onClick={() => (open ? closeMenu(false) : openMenu())}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="native-work-default-avatar" aria-hidden="true">{avatarLabel}</span>
        <span className="native-work-agent-trigger-label">{label}</span>
        <RoomChevronIcon />
      </button>
      {status ? <span className="native-work-agent-status">{status}</span> : null}
      {open ? (
        <div id={menuId} className="native-work-agent-menu" role="listbox" aria-label={ariaLabel} onKeyDown={handleMenuKeyDown}>
          {options.map((option, index) => (
            <button
              key={option.id}
              ref={(element) => { optionRefs.current[index] = element; }}
              type="button"
              role="option"
              className={`native-work-agent-option${index === activeIndex ? " is-active" : ""}${option.id === value ? " is-selected" : ""}`}
              aria-selected={option.id === value}
              disabled={option.disabled}
              tabIndex={index === activeIndex ? 0 : -1}
              onFocus={() => setActiveIndex(index)}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => commitOption(index)}
            >
              <span className="native-work-agent-option-avatar" aria-hidden="true">{option.label.trim().slice(0, 1) || "?"}</span>
              <span className="native-work-agent-option-label">{option.label}</span>
              {option.id === value ? <span className="native-work-agent-option-check" aria-hidden="true">✓</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
