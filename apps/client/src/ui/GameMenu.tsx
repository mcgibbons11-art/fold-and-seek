import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type RefObject,
} from "react";

import { type QualityTier } from "../rendering/quality";
import { HotkeyGuide } from "./HotkeyGuide";
import { PlayerSettingsPanel } from "./PlayerSettingsPanel";
import { REPLAY_ONBOARDING_EVENT } from "./FirstRoundGuide";
import {
  BRASS_LIT,
  CREAM,
  FONT_DISPLAY,
  FONT_UI,
  PRESS_CLASS,
  buttonStyle,
  labelStyle,
  plate,
  primaryButtonStyle,
} from "./rounds/theme";

type MenuPage = "root" | "settings" | "howToPlay" | "confirmLeave";
export const REQUEST_LEAVE_MATCH_EVENT = "foldseek:request-leave-match";

const menuButtonStyle: CSSProperties = {
  ...buttonStyle,
  position: "absolute",
  top: 14,
  right: 14,
  zIndex: 120,
  width: "auto",
  margin: 0,
  padding: "7px 12px",
  fontSize: 10,
};

const pageButtonStyle: CSSProperties = { ...buttonStyle, width: "100%", marginBottom: 8 };
const MENU_FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

function focusableMenuItems(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(MENU_FOCUSABLE)].filter(
    (element) => !element.hidden && element.getAttribute("aria-hidden") !== "true",
  );
}

function moveMenuFocus(root: HTMLElement, delta: number): void {
  const items = focusableMenuItems(root);
  if (items.length === 0) return;
  const current = items.indexOf(document.activeElement as HTMLElement);
  const next = current < 0 ? (delta > 0 ? 0 : items.length - 1) : (current + delta + items.length) % items.length;
  items[next]?.focus({ preventScroll: true });
}

/** Native gamepads do not emit DOM key events, so the pause menu samples their edge presses. */
function useGamepadMenu(
  open: boolean,
  dialogRef: RefObject<HTMLDivElement | null>,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!open || typeof navigator.getGamepads !== "function") return undefined;
    let lastDirection = 0;
    let lastAccept = false;
    let lastBack = false;
    const timer = window.setInterval(() => {
      const pad = [...navigator.getGamepads()].find((candidate) => candidate?.connected) ?? null;
      if (pad === null) return;
      const direction = pad.buttons[12]?.pressed || (pad.axes[1] ?? 0) < -0.55
        ? -1
        : pad.buttons[13]?.pressed || (pad.axes[1] ?? 0) > 0.55
          ? 1
          : 0;
      const accept = pad.buttons[0]?.pressed ?? false;
      const back = pad.buttons[1]?.pressed ?? false;
      const dialog = dialogRef.current;
      if (dialog !== null && direction !== 0 && lastDirection === 0) {
        moveMenuFocus(dialog, direction);
      }
      if (accept && !lastAccept && document.activeElement instanceof HTMLElement) {
        document.activeElement.click();
      }
      if (back && !lastBack) onClose();
      lastDirection = direction;
      lastAccept = accept;
      lastBack = back;
    }, 50);
    return () => window.clearInterval(timer);
  }, [dialogRef, onClose, open]);
}

export interface GameMenuProps {
  readonly qualityTier: QualityTier;
  readonly onQualityTierChange: (tier: QualityTier) => void;
  readonly onLeave: () => void | Promise<void>;
  readonly role: "mimic" | "inspector" | "spectator" | null;
}

/** One quiet entry point for help, settings, and leaving instead of three permanent HUD buttons. */
export function GameMenu(props: GameMenuProps): ReactElement {
  const [page, setPage] = useState<MenuPage | null>(null);
  const [leaving, setLeaving] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const leaveRequestedRef = useRef(false);


  const openTo = useCallback((nextPage: MenuPage): void => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : menuButtonRef.current;
    if (document.pointerLockElement != null && typeof document.exitPointerLock === "function") {
      void document.exitPointerLock();
    }
    setPage(nextPage);
  }, []);
  const open = useCallback((): void => openTo("root"), [openTo]);

  const close = useCallback((): void => {
    if (leaveRequestedRef.current) return;
    setPage(null);
  }, []);

  useEffect(() => {
    const onLeaveRequest = (): void => openTo("confirmLeave");
    window.addEventListener(REQUEST_LEAVE_MATCH_EVENT, onLeaveRequest);
    return () => window.removeEventListener(REQUEST_LEAVE_MATCH_EVENT, onLeaveRequest);
  }, [openTo]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "F1") {
        event.preventDefault();
        if (page === null) open();
        else close();
      } else if (event.key === "Escape" && page !== null) {
        event.preventDefault();
        close();
      } else if (page !== null && dialogRef.current !== null) {
        const dialog = dialogRef.current;
        if (event.key === "Tab") {
          const items = focusableMenuItems(dialog);
          if (items.length === 0) return;
          const first = items[0];
          const last = items.at(-1);
          if (!dialog.contains(document.activeElement)) {
            event.preventDefault();
            (event.shiftKey ? last : first)?.focus();
          } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        } else if (
          !(event.target instanceof HTMLInputElement) &&
          ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(event.key)
        ) {
          event.preventDefault();
          moveMenuFocus(dialog, event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1);
        } else if (event.key === "Home" || event.key === "End") {
          const items = focusableMenuItems(dialog);
          event.preventDefault();
          (event.key === "Home" ? items[0] : items.at(-1))?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, open, page]);

  useLayoutEffect(() => {
    if (page === null) {
      const restore = restoreFocusRef.current;
      restoreFocusRef.current = null;
      restore?.focus({ preventScroll: true });
      return;
    }
    const dialog = dialogRef.current;
    const preferred = dialog?.querySelector<HTMLElement>('[data-menu-focus="true"]');
    (preferred ?? (dialog === null ? null : focusableMenuItems(dialog)[0]))?.focus({
      preventScroll: true,
    });
  }, [page]);

  useGamepadMenu(page !== null, dialogRef, close);

  const leave = (): void => {
    if (leaveRequestedRef.current) return;
    leaveRequestedRef.current = true;
    setLeaving(true);
    try {
      void Promise.resolve(props.onLeave()).catch(() => {
        leaveRequestedRef.current = false;
        setLeaving(false);
      });
    } catch {
      leaveRequestedRef.current = false;
      setLeaving(false);
    }
  };

  return (
    <>
      <button ref={menuButtonRef} type="button" className={PRESS_CLASS} style={menuButtonStyle} onClick={open}>
        Menu
      </button>
      {page === null ? null : (
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="game-menu-title"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 200,
            display: "grid",
            placeItems: "center",
            padding: 20,
            boxSizing: "border-box",
            pointerEvents: "auto",
            background: "rgba(8, 6, 4, 0.72)",
            color: CREAM,
            font: `13px/1.55 ${FONT_UI}`,
          }}
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) close();
          }}
        >
          <div
            style={{
              ...plate(true),
              width: "min(470px, calc(100vw - 40px))",
              maxHeight: "min(720px, calc(100vh - 40px))",
              overflowY: "auto",
              boxSizing: "border-box",
              padding: "24px 26px",
              borderRadius: 14,
              boxShadow: "0 28px 90px rgba(0, 0, 0, 0.65)",
            }}
          >
            <div style={{ ...labelStyle, color: BRASS_LIT, opacity: 1, marginBottom: 5 }}>Fold & Seek</div>
            <div id="game-menu-title" style={{ font: `600 25px/1.15 ${FONT_DISPLAY}`, marginBottom: 20 }}>
              {page === "root"
                ? "Game menu"
                : page === "settings"
                  ? "Settings"
                  : page === "howToPlay"
                    ? "How to play"
                    : "Leave match?"}
            </div>

            {page === "root" ? (
              <>
                <button type="button" className={PRESS_CLASS} style={primaryButtonStyle} onClick={close} data-menu-focus="true">
                  Resume
                </button>
                <button type="button" className={PRESS_CLASS} style={pageButtonStyle} onClick={() => setPage("settings")}>
                  Settings
                </button>
                <button type="button" className={PRESS_CLASS} style={pageButtonStyle} onClick={() => setPage("howToPlay")}>
                  How to play
                </button>
                <button
                  type="button"
                  className={PRESS_CLASS}
                  style={{ ...pageButtonStyle, marginTop: 18, color: "#ffc0a8" }}
                  onClick={() => setPage("confirmLeave")}
                >
                  Leave match and return to menu
                </button>
              </>
            ) : null}

            {page === "confirmLeave" ? (
              <>
                <p style={{ margin: "0 0 18px", opacity: 0.82 }}>
                  You will leave this room and give up your place in the current round.
                </p>
                <button
                  type="button"
                  className={PRESS_CLASS}
                  style={primaryButtonStyle}
                  onClick={() => setPage("root")}
                  disabled={leaving}
                  data-menu-focus="true"
                >
                  Stay in match
                </button>
                <button
                  type="button"
                  className={PRESS_CLASS}
                  style={{ ...pageButtonStyle, color: "#ffc0a8" }}
                  onClick={leave}
                  disabled={leaving}
                  aria-busy={leaving}
                >
                  {leaving ? "Returning to menuâ€¦" : "Leave match"}
                </button>
              </>
            ) : null}

            {page === "settings" ? (
              <>
                <PlayerSettingsPanel
                  qualityTier={props.qualityTier}
                  onQualityTierChange={props.onQualityTierChange}
                />
                <button type="button" className={PRESS_CLASS} style={pageButtonStyle} onClick={() => setPage("root")}>
                  Back
                </button>
              </>
            ) : null}

            {page === "howToPlay" ? (
              <>
                <p style={{ opacity: 0.82, marginTop: 0 }}>
                  Mimics reshape, panel, and paint themselves to blend into the room. The Inspector spends a limited warrant with every shot, so accuse only what does not belong.
                </p>
                <HotkeyGuide role={props.role} />
                <button
                  type="button"
                  className={PRESS_CLASS}
                  style={{ ...pageButtonStyle, marginTop: 18 }}
                  onClick={() => {
                    window.dispatchEvent(new Event(REPLAY_ONBOARDING_EVENT));
                    setPage(null);
                  }}
                >
                  Replay first-round guide
                </button>
                <button type="button" className={PRESS_CLASS} style={pageButtonStyle} onClick={() => setPage("root")}>
                  Back
                </button>
              </>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}
