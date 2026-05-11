"""
Tapo / Kasa bridge (v3) — full feature parity with python-kasa 0.10.2.

Subcommands (all return JSON to stdout, exit 0=ok, 1=error):

  status            --ip --user --pass
  discover          --ip --user --pass
  discover-network  --user --pass [--target X.X.X.X] [--timeout 8]
                    -- broadcast scan + TPAP fallback via try_connect_all
  set               --ip --user --pass --device-id ID --state on|off
                    [--verify] [--allow-momentary]
  light             --ip --user --pass --device-id ID
                    [--brightness 0-100] [--hsv H,S,V] [--color-temp K]
                    [--effect NAME]
  fan               --ip --user --pass --device-id ID --speed 0-4
  countdown         --ip --user --pass --device-id ID --seconds N --action on|off
  energy            --ip --user --pass --device-id ID
  effects           --ip --user --pass --device-id ID
  feature           --ip --user --pass --device-id ID --name FEAT [--value V]
                    -- read or set any python-kasa Feature by id
"""
from __future__ import annotations

import sys
import os
import re
import json
import base64
import argparse
import asyncio
from typing import Any

LIBS = os.environ.get("PYTHON_LIBS") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "python-libs"
)
sys.path.insert(0, os.path.abspath(LIBS))

from kasa import Credentials, Discover, Device  # noqa: E402
from kasa.exceptions import (  # noqa: E402
    KasaException,
    UnsupportedDeviceError,
    AuthenticationError,
    TimeoutError as KasaTimeoutError,
)
from kasa.deviceconfig import (  # noqa: E402
    DeviceConfig, DeviceConnectionParameters,
    DeviceFamily, DeviceEncryptionType,
)
from kasa.device_factory import _connect as _kasa_connect, get_protocol  # noqa: E402


# ---------------------------------------------------------------- helpers

def _credentials(args) -> Credentials | None:
    if getattr(args, "user", None) and getattr(args, "password", None):
        return Credentials(args.user, args.password)
    return None


def _safe(getter, default=None):
    try:
        return getter()
    except Exception:
        return default


_IP_RE = re.compile(r"\b(\d{1,3}(?:\.\d{1,3}){3})\b")


def _extract_ip(s: str) -> str | None:
    m = _IP_RE.search(s or "")
    return m.group(1) if m else None


# ---------------------------------------------------------------- classify

_BUTTON_HINTS = ("button", "smartbutton", "s200")
# Real bulb / light strip hints — these are NEVER momentary even if their
# is_on is None at first read (older firmware fw on TPAP).
_LIGHT_HINTS = ("bulb", "light", "l5", "l9", "l10", "kl1", "kl4", "kl5", "kl9")
_PLUG_HINTS = ("plug", "p100", "p105", "p110", "p115", "hs1", "hs2", "hs3", "kp")
_SWITCH_HINTS = ("switch", "wallswitch", "s5", "hs200", "hs210", "ks2")


def _decode_alias_b64(v: str | None) -> str | None:
    if not v:
        return None
    try:
        return base64.b64decode(v).decode("utf-8")
    except Exception:
        return v  # already plain text


def _device_alias(dev: Device) -> str | None:
    """
    Robust alias extraction. python-kasa's `dev.alias` reads `_info["nickname"]`
    (base64). On older P110/L530 firmware after brute-force connect, alias
    sometimes returns None even though the nickname is present in raw
    device_info. Try multiple paths.
    """
    a = _safe(lambda: dev.alias)
    if a:
        return a
    info = _safe(lambda: dev._info, {}) or {}
    for k in ("nickname", "alias", "device_alias", "name"):
        v = info.get(k)
        if not v:
            continue
        if k == "nickname":
            d = _decode_alias_b64(v)
            if d:
                return d
        else:
            return v
    di = _safe(lambda: dev.device_info, None)
    if di is not None:
        for attr in ("nickname", "alias", "name"):
            v = _safe(lambda a=attr: getattr(di, a, None))
            if v:
                return _decode_alias_b64(v) if attr == "nickname" else v
    return None


def _is_momentary(dev: Device) -> bool:
    """
    A device with no real on/off state (Tapo S200B button etc.).
    DO NOT rely on `dev.is_on is None` — older P110/L530 firmware reports
    is_on=None right after handshake even though the device IS toggleable.
    """
    dt = str(getattr(dev, "device_type", "") or "").lower()
    model = (str(_safe(lambda: dev.model)) or "").lower()
    mods = list(getattr(dev, "modules", {}) or {})
    # Bulbs / switches / plugs are NEVER momentary regardless of is_on state
    if ("Brightness" in mods or "Color" in mods or "ColorTemperature" in mods
            or "Energy" in mods or "Emeter" in mods or "Fan" in mods):
        return False
    if any(h in dt for h in _LIGHT_HINTS + _PLUG_HINTS + _SWITCH_HINTS):
        return False
    if any(h in model for h in _LIGHT_HINTS + _PLUG_HINTS + _SWITCH_HINTS):
        return False
    # Explicit button hints
    if any(h in dt for h in _BUTTON_HINTS) or any(h in model for h in _BUTTON_HINTS):
        return True
    # No button hint AND device has no toggle attribute at all
    if not hasattr(dev, "is_on"):
        return False
    return False


def _device_kind(dev: Device, is_child: bool = False) -> str:
    dt = str(getattr(dev, "device_type", "") or "").lower()
    model = (str(_safe(lambda: dev.model)) or "").lower()
    mods = list(getattr(dev, "modules", {}) or {})
    feats = set(getattr(dev, "features", {}) or {})

    if "hub" in dt:
        return "hub"
    # Sensors first (some have batteries but no toggle)
    has_temp = "TemperatureSensor" in mods or "temperature" in feats
    has_hum  = "HumiditySensor" in mods
    has_motion  = "MotionSensor" in mods
    has_contact = "ContactSensor" in mods
    has_leak    = "WaterleakSensor" in mods
    if has_temp or has_hum:
        return "sensor"
    if has_motion:
        return "motion"
    if has_contact:
        return "contact"
    if has_leak:
        return "leak"
    # Light: detect by modules first (most reliable for older fw),
    # then by device_type / model name hints.
    if ("Brightness" in mods or "Color" in mods or "ColorTemperature" in mods
            or "LightEffect" in mods):
        return "bulb"
    if "bulb" in dt or "light" in dt or any(h in model for h in _LIGHT_HINTS):
        return "bulb"
    if "fan" in dt or "Fan" in mods:
        return "fan"
    if "strip" in dt:
        return "strip"
    if "plug" in dt or any(h in model for h in _PLUG_HINTS):
        return "switch" if is_child else "plug"
    if "switch" in dt or "wallswitch" in dt or any(h in model for h in _SWITCH_HINTS):
        return "switch"
    if not is_child and getattr(dev, "children", None):
        return "hub"
    # Only NOW check momentary (button) — sensors/bulbs/plugs already returned
    if _is_momentary(dev):
        return "button"
    if hasattr(dev, "is_on"):
        return "switch" if is_child else "plug"
    return "unknown"

def _capabilities(dev: Device) -> dict[str, Any]:
    mods = dict(getattr(dev, "modules", {}) or {})
    feats = dict(getattr(dev, "features", {}) or {})
    momentary = _is_momentary(dev)
    caps: dict[str, Any] = {
        "modules": list(mods.keys()),
        "features": list(feats.keys()),
        "can_toggle": hasattr(dev, "is_on") and not momentary,
        "is_momentary": momentary,
    }
    if "Brightness" in mods:
        caps["brightness"] = True
    if "Color" in mods:
        caps["color"] = True
    if "ColorTemperature" in mods:
        m = mods["ColorTemperature"]
        rng = _safe(lambda: m.valid_temperature_range)
        caps["color_temp"] = {"range": list(rng) if rng else None}
    if "LightEffect" in mods:
        m = mods["LightEffect"]
        caps["light_effect"] = {
            "current": _safe(lambda: m.effect),
            "list": _safe(lambda: list(m.effect_list), []) or [],
        }
    if "LightPreset" in mods:
        m = mods["LightPreset"]
        caps["light_preset"] = {
            "current": _safe(lambda: m.preset),
            "list": _safe(lambda: list(m.preset_list), []) or [],
        }
    if "Fan" in mods:
        caps["fan"] = True
    if "Energy" in mods or "Emeter" in mods:
        caps["energy"] = True
    if "Countdown" in mods:
        caps["countdown_native"] = True
    if "BatterySensor" in mods:
        caps["battery"] = True
    if "MotionSensor" in mods:
        caps["motion"] = True
    if "ContactSensor" in mods:
        caps["contact"] = True
    if "WaterleakSensor" in mods:
        caps["water_leak"] = True
    return caps


# ---------------------------------------------------------------- serialize

def _serialize(dev: Device, parent_id: str | None = None) -> dict[str, Any]:
    is_child = parent_id is not None
    mods = dict(getattr(dev, "modules", {}) or {})
    info = _safe(lambda: dev.state_information, {}) or {}

    temperature = _safe(lambda: mods["TemperatureSensor"].temperature) if "TemperatureSensor" in mods else None
    if temperature is None:
        temperature = info.get("Temperature") or info.get("Current Temperature")
    humidity = _safe(lambda: mods["HumiditySensor"].humidity) if "HumiditySensor" in mods else None
    if humidity is None:
        humidity = info.get("Humidity") or info.get("Current Humidity")

    state = None
    if hasattr(dev, "is_on") and not _is_momentary(dev):
        try:
            v = dev.is_on
            state = 1 if v else 0 if v is not None else None
        except Exception:
            state = None

    brightness = _safe(lambda: mods["Brightness"].brightness) if "Brightness" in mods else None
    hsv = _safe(lambda: list(mods["Color"].hsv)) if "Color" in mods else None
    color_temp = _safe(lambda: mods["ColorTemperature"].color_temp) if "ColorTemperature" in mods else None
    fan_speed = _safe(lambda: mods["Fan"].fan_speed_level) if "Fan" in mods else None
    battery = _safe(lambda: mods["BatterySensor"].battery) if "BatterySensor" in mods else None
    motion = _safe(lambda: mods["MotionSensor"].motion_detected) if "MotionSensor" in mods else None

    energy = None
    if "Energy" in mods:
        em = mods["Energy"]
        energy = {
            "power_w": _safe(lambda: em.current_consumption),
            "today_kwh": _safe(lambda: em.consumption_today),
            "month_kwh": _safe(lambda: em.consumption_this_month),
        }
    elif "Emeter" in mods:
        em = mods["Emeter"]
        energy = {
            "power_w": _safe(lambda: em.status.power),
            "today_kwh": _safe(lambda: em.consumption_today),
            "month_kwh": _safe(lambda: em.consumption_this_month),
        }

    dinfo = getattr(dev, "device_info", None)
    model = (getattr(dinfo, "long_name", None) if dinfo else None) or _safe(lambda: dev.model)

    return {
        "device_id": getattr(dev, "device_id", None),
        "parent_device_id": parent_id,
        "kind": _device_kind(dev, is_child=is_child),
        "tapo_alias": _device_alias(dev),
        "model": model,
        "device_type": str(getattr(dev, "device_type", "") or ""),
        "mac": _safe(lambda: dev.mac),
        "rssi": _safe(lambda: dev.rssi),
        "temperature": float(temperature) if temperature is not None else None,
        "humidity": float(humidity) if humidity is not None else None,
        "state": state,
        "brightness": brightness,
        "hsv": hsv,
        "color_temp": color_temp,
        "fan_speed": fan_speed,
        "battery": battery,
        "motion": bool(motion) if motion is not None else None,
        "energy": energy,
        "capabilities": _capabilities(dev),
    }


def _flatten(dev: Device, parent_id: str | None = None) -> list[dict]:
    out: list[dict] = []
    children = list(getattr(dev, "children", []) or [])
    if children:
        out.append({**_serialize(dev, parent_id=parent_id), "kind": "hub"})
        for ch in children:
            out.extend(_flatten(ch, parent_id=getattr(dev, "device_id", None)))
    else:
        out.append(_serialize(dev, parent_id=parent_id))
    return out


def _find_node(root: Device, target_id: str) -> Device | None:
    if getattr(root, "device_id", None) == target_id:
        return root
    for ch in getattr(root, "children", []) or []:
        f = _find_node(ch, target_id)
        if f:
            return f
    return None


# ---------------------------------------------------------------- connect

# All families we want to brute-force when discovery fails.
# python-kasa's built-in Discover.try_connect_all skips bulbs/switches/hubs
# (only iterates SmartTapoPlug + IotSmartPlugSwitch + cameras), which means
# L530, L900, KS220, KH100, etc. cannot be recovered. We extend it here.
_BRUTE_FAMILIES: tuple[DeviceFamily, ...] = (
    DeviceFamily.SmartTapoPlug,
    DeviceFamily.SmartTapoBulb,
    DeviceFamily.SmartTapoSwitch,
    DeviceFamily.SmartTapoHub,
    DeviceFamily.SmartKasaPlug,
    DeviceFamily.SmartKasaSwitch,
    DeviceFamily.SmartKasaHub,
    DeviceFamily.IotSmartPlugSwitch,
    DeviceFamily.IotSmartBulb,
)
# KLAP first (most modern), AES second (covers TPAP/older P110/L530 fw),
# XOR last (legacy IOT only).
_BRUTE_ENCRYPTS: tuple[DeviceEncryptionType, ...] = (
    DeviceEncryptionType.Klap,
    DeviceEncryptionType.Aes,
    DeviceEncryptionType.Xor,
)


async def _brute_connect(
    ip: str,
    creds: Credentials | None,
    *,
    timeout: int = 8,
    http_port: int | None = None,
    family_hint: DeviceFamily | None = None,
    https_hint: bool | None = None,
    lv_hint: int | None = None,
) -> tuple[Device | None, list[dict]]:
    """
    Brute-force ALL plausible (family, encryption, https, login_version)
    combinations using kasa.device_factory._connect directly. This bypasses
    UDP discovery and the encrypt_type='TPAP' rejection: TPAP devices accept
    the AES (or KLAP) handshake when called directly.

    Returns (device|None, attempts_log).
    """
    attempts: list[dict] = []

    def _ordered(seq, hint):
        if hint is None:
            return list(seq)
        return [hint] + [x for x in seq if x != hint]

    families = _ordered(_BRUTE_FAMILIES, family_hint)
    encrypts = _ordered(_BRUTE_ENCRYPTS, None)
    https_opts = _ordered((False, True), https_hint)
    lv_opts = _ordered((2, None, 1), lv_hint)

    for family in families:
        for encrypt in encrypts:
            for https in https_opts:
                for lv in lv_opts:
                    # Skip absurd combos (XOR is only for IOT family on port 9999)
                    if (encrypt is DeviceEncryptionType.Xor
                            and family is not DeviceFamily.IotSmartPlugSwitch
                            and family is not DeviceFamily.IotSmartBulb):
                        continue
                    try:
                        conn = DeviceConnectionParameters(
                            device_family=family,
                            encryption_type=encrypt,
                            login_version=lv,
                            https=https,
                            http_port=http_port,
                        )
                    except Exception:
                        continue
                    cfg = DeviceConfig(
                        host=ip,
                        connection_type=conn,
                        timeout=timeout,
                        credentials=creds,
                    )
                    proto = get_protocol(cfg, strict=True)
                    if proto is None:
                        continue
                    label = (f"{family.value}/{encrypt.value}"
                             f"/lv={lv}/https={https}/port={http_port or 'def'}")
                    try:
                        dev = await _kasa_connect(cfg, proto)
                        attempts.append({"protocol": label, "ok": True})
                        return dev, attempts
                    except AuthenticationError as e:
                        attempts.append({"protocol": label, "auth_error": str(e)})
                        # Auth failure means creds are wrong — no point continuing
                        # with other protocols if AES already authenticated us
                        # back. But sometimes it just means "not this protocol".
                        try:
                            await proto.close()
                        except Exception:
                            pass
                        continue
                    except (UnsupportedDeviceError, KasaTimeoutError, KasaException, OSError) as e:
                        attempts.append({"protocol": label, "error": str(e)[:120]})
                        try:
                            await proto.close()
                        except Exception:
                            pass
                        continue
                    except Exception as e:  # last-resort catch
                        attempts.append({"protocol": label, "error": f"{type(e).__name__}: {str(e)[:80]}"})
                        try:
                            await proto.close()
                        except Exception:
                            pass
                        continue
    return None, attempts


# Parse hints from the EncryptionScheme repr produced by python-kasa
_SCHEME_RE = re.compile(
    r"is_support_https\s*=\s*(True|False).*?"
    r"encrypt_type\s*=\s*'([^']+)'.*?"
    r"http_port\s*=\s*(\d+).*?"
    r"lv\s*=\s*(\d+)",
    re.DOTALL,
)
_TYPE_RE = re.compile(r"of\s+type\s+(SMART\.\w+)")


def _parse_unsupported_hints(text: str) -> dict:
    out: dict = {}
    if (m := _SCHEME_RE.search(text or "")):
        out["https"] = m.group(1) == "True"
        out["encrypt_type"] = m.group(2)
        out["http_port"] = int(m.group(3))
        out["lv"] = int(m.group(4))
    if (m := _TYPE_RE.search(text or "")):
        out["device_type"] = m.group(1)
    return out


def _family_from_type(dt: str | None) -> DeviceFamily | None:
    try:
        return DeviceFamily(dt) if dt else None
    except Exception:
        return None


async def _connect_with_fallback(ip: str, creds: Credentials | None,
                                 timeout: int = 10) -> Device:
    """
    1) Try Discover.discover_single — fast, works for KLAP/AES with valid scheme.
    2) On UnsupportedDeviceError (typically TPAP / older fw on port 80) or
       any KasaException, fall back to extended brute-force across ALL
       families (incl. SmartTapoBulb, SmartTapoSwitch, SmartTapoHub) and ports.
    """
    sd_error: dict | None = None
    try:
        dev = await Discover.discover_single(
            ip, credentials=creds, discovery_timeout=timeout
        )
        if dev is not None:
            return dev
    except UnsupportedDeviceError as e:
        # Use the discovery hint to seed the brute-force order
        sd_error = _parse_unsupported_hints(str(e))
    except (KasaTimeoutError, KasaException):
        pass

    # http_port=80 is the default for non-https devices (P110/L530 with TPAP)
    hint_port = (sd_error or {}).get("http_port")
    hint_family = _family_from_type((sd_error or {}).get("device_type"))
    hint_https = (sd_error or {}).get("https")
    hint_lv = (sd_error or {}).get("lv")

    dev, attempts = await _brute_connect(
        ip, creds, timeout=timeout,
        http_port=hint_port,
        family_hint=hint_family,
        https_hint=hint_https,
        lv_hint=hint_lv,
    )
    if dev is None:
        # Build a concise diagnostic
        last = attempts[-3:] if attempts else []
        msg = (f"Unable to connect to {ip} with any known protocol. "
               f"Tried {len(attempts)} combinations. "
               f"Last attempts: {last}")
        raise UnsupportedDeviceError(msg, host=ip)
    return dev


async def _connect(args) -> Device:
    creds = _credentials(args)
    return await _connect_with_fallback(args.ip, creds)


# ---------------------------------------------------------------- commands

async def cmd_status(args):
    dev = await _connect(args)
    await dev.update()
    return {"ok": True, "ip": args.ip, "devices": _flatten(dev)}


async def cmd_discover(args):
    return await cmd_status(args)


async def cmd_discover_network(args):
    """
    Broadcast UDP discovery + extended brute-force fallback for unsupported
    (TPAP / older P110 / L530) devices. Skips IPs in --exclude-ip.
    """
    creds = _credentials(args)
    excluded = set(filter(None, (args.exclude_ip or "").split(",")))

    unsupported_raw: list[dict] = []
    unsupported_hints: dict[str, dict] = {}

    def _on_unsupported(disc):
        try:
            txt = str(disc)
            ip = getattr(disc, "host", None) or _extract_ip(txt)
            if ip and ip in excluded:
                return  # we already have it
            hints = _parse_unsupported_hints(txt)
            entry = {"info": txt, "ip": ip, "hints": hints}
            unsupported_raw.append(entry)
            if ip:
                unsupported_hints[ip] = hints
        except Exception:
            pass

    devices = await Discover.discover(
        target=args.target,
        credentials=creds,
        discovery_timeout=args.timeout,
        on_unsupported=_on_unsupported,
    )

    found: list[dict] = []
    for ip, dev in devices.items():
        if ip in excluded:
            continue
        try:
            await dev.update()
            for entry in _flatten(dev):
                entry["ip"] = ip
                found.append(entry)
        except Exception as e:
            found.append({
                "ip": ip,
                "device_id": getattr(dev, "device_id", None),
                "tapo_alias": getattr(dev, "alias", None),
                "kind": "unknown",
                "error": str(e),
            })

    # ------- fallback: extended brute-force for each unsupported IP -------
    recovered: list[dict] = []
    still_unsupported: list[dict] = []
    for u in unsupported_raw:
        ip = u.get("ip")
        if not ip or ip in excluded:
            continue
        hints = u.get("hints") or {}
        try:
            dev, attempts = await _brute_connect(
                ip, creds, timeout=10,
                http_port=hints.get("http_port"),
                family_hint=_family_from_type(hints.get("device_type")),
                https_hint=hints.get("https"),
                lv_hint=hints.get("lv"),
            )
            if dev is None:
                still_unsupported.append({
                    **u,
                    "fallback_error": (
                        f"All {len(attempts)} protocol attempts failed"
                    ),
                    "attempts": attempts[-5:],
                })
                continue
            await dev.update()
            for entry in _flatten(dev):
                entry["ip"] = ip
                entry["recovered_via"] = "brute_force"
                found.append(entry)
                recovered.append({"ip": ip, "device_id": entry.get("device_id")})
        except Exception as e:
            still_unsupported.append({**u, "fallback_error": str(e)})

    return {
        "ok": True,
        "found": found,
        "recovered": recovered,
        "unsupported": still_unsupported,
        "excluded_count": len(excluded),
    }


async def cmd_set(args):
    dev = await _connect(args)
    await dev.update()
    target = _find_node(dev, args.device_id)
    if target is None:
        return {"ok": False, "error": f"device_id {args.device_id} not found at {args.ip}"}

    momentary = _is_momentary(target)
    desired = args.state.lower() in ("on", "1", "true")

    if momentary and not args.allow_momentary:
        return {
            "ok": False,
            "error": "Device is momentary (button-like) and has no toggle state. "
                     "Pass --allow-momentary to send the press anyway.",
            "is_momentary": True,
        }

    await target.set_state(desired)

    verified = None
    actual = None
    if args.verify and not momentary:
        await asyncio.sleep(1.5)
        try:
            await dev.update()
            t2 = _find_node(dev, args.device_id)
            actual = (1 if bool(getattr(t2, "is_on", False)) else 0) if t2 else None
            verified = (actual == (1 if desired else 0))
        except Exception:
            verified = False

    return {
        "ok": True,
        "device_id": args.device_id,
        "requested": 1 if desired else 0,
        "actual": actual,
        "verified": verified,
        "is_momentary": momentary,
    }


async def cmd_light(args):
    dev = await _connect(args)
    await dev.update()
    target = _find_node(dev, args.device_id)
    if target is None:
        return {"ok": False, "error": "device not found"}
    mods = dict(getattr(target, "modules", {}) or {})

    applied: dict[str, Any] = {}
    # Auto-on if needed: most bulbs ignore color/brightness when off
    if (args.brightness is not None or args.hsv is not None
            or args.color_temp is not None or args.effect is not None):
        if hasattr(target, "is_on") and not target.is_on:
            try:
                await target.set_state(True)
                applied["auto_on"] = True
            except Exception:
                pass

    if args.brightness is not None:
        if "Brightness" not in mods:
            return {"ok": False, "error": "no Brightness module"}
        await mods["Brightness"].set_brightness(int(args.brightness))
        applied["brightness"] = int(args.brightness)
    if args.hsv is not None:
        if "Color" not in mods:
            return {"ok": False, "error": "no Color module"}
        h, s, v = (int(x) for x in args.hsv.split(","))
        await mods["Color"].set_hsv(h, s, v)
        applied["hsv"] = [h, s, v]
    if args.color_temp is not None:
        if "ColorTemperature" not in mods:
            return {"ok": False, "error": "no ColorTemperature module"}
        await mods["ColorTemperature"].set_color_temp(int(args.color_temp))
        applied["color_temp"] = int(args.color_temp)
    if args.effect is not None:
        if "LightEffect" not in mods:
            return {"ok": False, "error": "no LightEffect module"}
        await mods["LightEffect"].set_effect(args.effect)
        applied["effect"] = args.effect
    return {"ok": True, "applied": applied}


async def cmd_fan(args):
    dev = await _connect(args)
    await dev.update()
    target = _find_node(dev, args.device_id)
    if target is None:
        return {"ok": False, "error": "device not found"}
    mods = dict(getattr(target, "modules", {}) or {})
    if "Fan" not in mods:
        return {"ok": False, "error": "no Fan module"}
    await mods["Fan"].set_fan_speed_level(int(args.speed))
    return {"ok": True, "speed": int(args.speed)}


async def cmd_countdown(args):
    dev = await _connect(args)
    await dev.update()
    target = _find_node(dev, args.device_id)
    if target is None:
        return {"ok": False, "error": "device not found"}
    mods = dict(getattr(target, "modules", {}) or {})
    cd = mods.get("Countdown")
    if cd is None:
        return {"ok": False, "error": "device has no native Countdown module"}
    seconds = int(args.seconds)
    on = args.action.lower() == "on"
    try:
        if on:
            await cd.set_delay_on(delay_seconds=seconds)
        else:
            await cd.set_delay_off(delay_seconds=seconds)
    except Exception as e:
        return {"ok": False, "error": f"countdown failed: {e}"}
    return {"ok": True, "seconds": seconds, "action": "on" if on else "off"}


async def cmd_energy(args):
    dev = await _connect(args)
    await dev.update()
    target = _find_node(dev, args.device_id)
    if target is None:
        return {"ok": False, "error": "device not found"}
    mods = dict(getattr(target, "modules", {}) or {})
    em = mods.get("Energy") or mods.get("Emeter")
    if em is None:
        return {"ok": False, "error": "no energy module"}
    return {
        "ok": True,
        "power_w": _safe(lambda: getattr(em, "current_consumption", None)) or _safe(lambda: em.status.power),
        "today_kwh": _safe(lambda: em.consumption_today),
        "month_kwh": _safe(lambda: em.consumption_this_month),
        "total_kwh": _safe(lambda: em.consumption_total),
    }


async def cmd_effects(args):
    dev = await _connect(args)
    await dev.update()
    target = _find_node(dev, args.device_id)
    if target is None:
        return {"ok": False, "error": "device not found"}
    mods = dict(getattr(target, "modules", {}) or {})
    out: dict[str, Any] = {"ok": True}
    if "LightEffect" in mods:
        m = mods["LightEffect"]
        out["effects"] = _safe(lambda: list(m.effect_list), []) or []
        out["current_effect"] = _safe(lambda: m.effect)
    if "LightPreset" in mods:
        m = mods["LightPreset"]
        out["presets"] = _safe(lambda: list(m.preset_list), []) or []
        out["current_preset"] = _safe(lambda: m.preset)
    return out


async def cmd_feature(args):
    """Read or set any python-kasa Feature by id (advanced)."""
    dev = await _connect(args)
    await dev.update()
    target = _find_node(dev, args.device_id)
    if target is None:
        return {"ok": False, "error": "device not found"}
    feats = dict(getattr(target, "features", {}) or {})
    f = feats.get(args.name)
    if f is None:
        return {"ok": False, "error": f"feature {args.name} not found",
                "available": list(feats.keys())}
    if args.value is not None:
        try:
            v = json.loads(args.value)
        except Exception:
            v = args.value
        await f.set_value(v)
        return {"ok": True, "name": args.name, "set": v}
    return {"ok": True, "name": args.name, "value": _safe(lambda: f.value)}


# ---------------------------------------------------------------- cli

def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    def add_conn(sp):
        sp.add_argument("--ip", required=True)
        sp.add_argument("--user", required=True)
        sp.add_argument("--password", required=True)

    sp = sub.add_parser("status"); add_conn(sp)
    sp = sub.add_parser("discover"); add_conn(sp)

    sp = sub.add_parser("discover-network")
    sp.add_argument("--user", required=True)
    sp.add_argument("--password", required=True)
    sp.add_argument("--target", default="255.255.255.255")
    sp.add_argument("--timeout", type=int, default=8)
    sp.add_argument("--exclude-ip", dest="exclude_ip", default="",
                    help="Comma-separated IPs to skip (already-known devices)")

    sp = sub.add_parser("set"); add_conn(sp)
    sp.add_argument("--device-id", dest="device_id", required=True)
    sp.add_argument("--state", required=True, choices=["on", "off"])
    sp.add_argument("--verify", action="store_true")
    sp.add_argument("--allow-momentary", dest="allow_momentary", action="store_true")

    sp = sub.add_parser("light"); add_conn(sp)
    sp.add_argument("--device-id", dest="device_id", required=True)
    sp.add_argument("--brightness", type=int)
    sp.add_argument("--hsv", help="H,S,V")
    sp.add_argument("--color-temp", dest="color_temp", type=int)
    sp.add_argument("--effect")

    sp = sub.add_parser("fan"); add_conn(sp)
    sp.add_argument("--device-id", dest="device_id", required=True)
    sp.add_argument("--speed", type=int, required=True)

    sp = sub.add_parser("countdown"); add_conn(sp)
    sp.add_argument("--device-id", dest="device_id", required=True)
    sp.add_argument("--seconds", type=int, required=True)
    sp.add_argument("--action", required=True, choices=["on", "off"])

    sp = sub.add_parser("energy"); add_conn(sp)
    sp.add_argument("--device-id", dest="device_id", required=True)

    sp = sub.add_parser("effects"); add_conn(sp)
    sp.add_argument("--device-id", dest="device_id", required=True)

    sp = sub.add_parser("feature"); add_conn(sp)
    sp.add_argument("--device-id", dest="device_id", required=True)
    sp.add_argument("--name", required=True)
    sp.add_argument("--value", help="JSON-encoded value to set; omit to read")

    args = p.parse_args()
    handler = {
        "status": cmd_status, "discover": cmd_discover,
        "discover-network": cmd_discover_network,
        "set": cmd_set, "light": cmd_light, "fan": cmd_fan,
        "countdown": cmd_countdown, "energy": cmd_energy,
        "effects": cmd_effects, "feature": cmd_feature,
    }[args.cmd]

    try:
        result = asyncio.run(handler(args))
        sys.stdout.write(json.dumps(result, default=str))
        sys.exit(0 if result.get("ok", True) else 1)
    except UnsupportedDeviceError as e:
        sys.stdout.write(json.dumps({
            "ok": False, "type": "UnsupportedDeviceError", "error": str(e),
            "host": getattr(e, "host", None),
        }))
        sys.exit(1)
    except AuthenticationError as e:
        sys.stdout.write(json.dumps({"ok": False, "type": "AuthenticationError", "error": str(e)}))
        sys.exit(1)
    except KasaTimeoutError as e:
        sys.stdout.write(json.dumps({"ok": False, "type": "TimeoutError", "error": str(e)}))
        sys.exit(1)
    except KasaException as e:
        sys.stdout.write(json.dumps({"ok": False, "type": type(e).__name__, "error": str(e)}))
        sys.exit(1)
    except Exception as e:
        sys.stdout.write(json.dumps({"ok": False, "type": type(e).__name__, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
