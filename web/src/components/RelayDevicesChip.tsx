// RelayDevicesChip — device presence + per-device relay kill switch for
// the cloud remote view (spec 2026-06-07-device-relay-design). Sits in
// the home-breadcrumb bar next to AuthBadge, cloud builds only. Shows
// "● N live" when relay-connected devices can serve content; the popover
// lists them with a Disable toggle (DO-storage flag — severs relay
// without touching sync) and lets disabled devices be re-enabled.
import { useEffect, useRef, useState } from "react";
import {
  getRelayState,
  subscribeRelay,
  disableRelayDevice,
  enableRelayDevice,
  type RelayState,
} from "../data/relay";
import "./RelayDevicesChip.css";

export function RelayDevicesChip() {
  const [state, setState] = useState<RelayState>(getRelayState());
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => subscribeRelay(() => setState(getRelayState())), []);

  // Same outside-click dismissal as AuthBadge's menu.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const live = state.online.filter((d) => d.ready);

  async function toggle(deviceId: string, action: "disable" | "enable") {
    setBusyId(deviceId);
    try {
      if (action === "disable") await disableRelayDevice(deviceId);
      else await enableRelayDevice(deviceId);
    } catch {
      // Status poll will correct the view; nothing useful to render here.
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="relay-chip" ref={wrapRef}>
      <button
        type="button"
        className="relay-chip__pill"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={live.length > 0
          ? `${live.length} device${live.length === 1 ? "" : "s"} serving live content`
          : "No devices online — showing the synced mirror"}
      >
        <span className={`relay-chip__dot${live.length > 0 ? " relay-chip__dot--live" : ""}`} aria-hidden="true" />
        {live.length > 0 ? `${live.length} live` : "mirror"}
      </button>

      {open && (
        <div className="auth-chip__menu relay-chip__menu" role="menu">
          <div className="relay-chip__menu-title">Devices</div>
          {live.length === 0 && state.disabled.length === 0 && (
            <div className="relay-chip__menu-empty">
              No devices online. Open Oyster on a device to browse its
              files and search its sessions from here.
            </div>
          )}
          {live.map((d) => (
            <div key={d.device_id} className="relay-chip__device" role="menuitem">
              <span className="relay-chip__device-label" title={d.device_label ?? d.device_id}>
                <span className="relay-chip__dot relay-chip__dot--live" aria-hidden="true" />
                {d.device_label ?? d.device_id.slice(0, 8)}
              </span>
              <button
                type="button"
                className="relay-chip__device-action"
                disabled={busyId === d.device_id}
                onClick={() => void toggle(d.device_id, "disable")}
                title="Stop serving live content from this device (sync is unaffected)"
              >
                Disable
              </button>
            </div>
          ))}
          {state.disabled.map((d) => (
            <div key={d.device_id} className="relay-chip__device relay-chip__device--disabled" role="menuitem">
              <span className="relay-chip__device-label" title={d.device_label ?? d.device_id}>
                <span className="relay-chip__dot" aria-hidden="true" />
                {d.device_label ?? d.device_id.slice(0, 8)}
              </span>
              <button
                type="button"
                className="relay-chip__device-action"
                disabled={busyId === d.device_id}
                onClick={() => void toggle(d.device_id, "enable")}
                title="Allow this device to serve live content again"
              >
                Enable
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
