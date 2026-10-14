#!/usr/bin/env python3

'''
python meshlink_metrics.py --result
python meshlink_metrics.py --sender sender.txt --receiver receiver.txt --condition "A/B at 5 m, line of sight"
python meshlink_metrics.py --disc-times 2.03 3.38 4.25 5.04 --disc-attempts 4 \
   --conn-times 0.39 1.29 --conn-attempts 4 --ping-sent 50 --ping-recv 48 \
   --rtt-mean 18.3 --rtt-min 12.7 --rtt-max 37.3 --dup-counts 16 1 2 \
   --hops 1 2 3 4 5 --paths 2 --calib-file calib.csv
'''

"""
meshlink_metrics.py  -  compute MeshLink benchmark metrics from BENCH logs
or from values you type in yourself. Standard library only (Python 3.8+).

MODES
  1. Demo with built-in example values:
        python meshlink_metrics.py --demo

  2. From your two log files (sender log and receiver log):
        python meshlink_metrics.py --sender sender.txt --receiver receiver.txt \
               --condition "A/B at 5 m, line of sight"

  3. From values you type (any of these can be combined):
        python meshlink_metrics.py \
               --disc-times 2.03 3.38 4.25 5.04 --disc-attempts 4 \
               --conn-times 0.39 1.29 --conn-attempts 4 \
               --ping-sent 50 --ping-recv 48 \
               --rtt-mean 18.3 --rtt-min 12.7 --rtt-max 37.3 \
               --dup-counts 16 1 2 \
               --calib-file calib.csv

  Optional extras:
        --hops 1 2 3 4 5   --paths 2     (multi-hop projection, see below)
        --json                           (machine readable output)

FORMULAS (all units shown in the output)
  Discovery time          t(first DISCOVERED with n>=1) - t(first MESH_START)
  Discovery rate          sessions that found a peer / sessions attempted
  Connection time         t(first CONNECTED with n>=1) - t(first DISCOVERED n>=1)
  Connection success      sessions that connected / sessions attempted
  RTT                     t(PONG_RECV) - t(PING_SENT) for the same key
  PDR (%)                 100 * received / sent
  One-hop delay           (RTT - echo_processing) / 2
  Clock offset            median( PING_RECV_rx - PING_SENT_tx - RTT/2 )
  One-way loss-test delay t(LOSS_RECV) - t(LOSS_SENT) - clock_offset
  Precision               TP / (TP + FP)
  Recall                  TP / (TP + FN)
  F1                      2PR / (P + R)  =  2TP / (2TP + FP + FN)
  Brier score             mean( (confidence - outcome)^2 ), outcome in {0,1}
  ECE                     sum over bins of (|bin| / N) * |accuracy - mean confidence|
  Multi-hop PDR (model)   path = p^h ;  with k independent paths 1 - (1 - p^h)^k
  Multi-hop delay (model) h * one_hop_delay
The multi-hop numbers are a MODEL, not a measurement. Label them "simulated".
"""

import argparse
import csv
import json
import math
import re
import statistics
import sys

NAN = float("nan")

# --------------------------------------------------------------------------
# Small statistics helpers
# --------------------------------------------------------------------------

_T_CRIT = {1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447,
           7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179,
           13: 2.160, 14: 2.145, 15: 2.131, 16: 2.120, 17: 2.110, 18: 2.101,
           19: 2.093, 20: 2.086, 25: 2.060, 30: 2.042}


def _t_crit(df):
    """Two-sided 95% Student-t critical value (table lookup, 1.96 for df>30)."""
    if df > 30:
        return 1.96
    keys = [k for k in _T_CRIT if k <= df]
    return _T_CRIT[max(keys)]


def describe(values):
    """mean, std (sample), min, max, median, n and 95% CI half width."""
    vals = [float(v) for v in values]
    n = len(vals)
    if n == 0:
        return {"n": 0, "mean": NAN, "std": NAN, "min": NAN, "max": NAN,
                "median": NAN, "ci95_half": NAN}
    mean = statistics.fmean(vals)
    std = statistics.stdev(vals) if n > 1 else 0.0
    ci = _t_crit(n - 1) * std / math.sqrt(n) if n > 1 else NAN
    return {"n": n, "mean": mean, "std": std, "min": min(vals),
            "max": max(vals), "median": statistics.median(vals),
            "ci95_half": ci}


def wilson_interval(k, n, z=1.96):
    """95% Wilson score interval for a proportion k/n, returned in percent."""
    if n <= 0:
        return (NAN, NAN)
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (100 * max(0.0, centre - half), 100 * min(1.0, centre + half))


def rate(k, n):
    """Return {'k','n','pct','ci95_low','ci95_high'} for a success rate."""
    if n is None or n <= 0:
        return {"k": k, "n": n, "pct": NAN, "ci95_low": NAN, "ci95_high": NAN}
    lo, hi = wilson_interval(k, n)
    return {"k": k, "n": n, "pct": 100.0 * k / n,
            "ci95_low": lo, "ci95_high": hi}


# --------------------------------------------------------------------------
# Log parsing
# --------------------------------------------------------------------------

# matches:  6890716.871|46cf6d75|DISCOVERED|n=0|peers=[]
_LINE_RE = re.compile(r"(\d+(?:\.\d+)?)\|([0-9A-Fa-f]{6,8})\|([A-Z_]+)\|?(.*?)\s*$")


def parse_log(text):
    """
    Parse BENCH log text into a list of sessions.
    Each session is a list of events: {t_ms, dev, name, fields, rest}.
    A new session starts at a 'PROCESS STARTED' line, or at a DISCOVERED n=0
    event after the current session already logged MESH_START.
    """
    sessions, current = [], []
    new_session_pending = False
    for line in text.splitlines():
        if "PROCESS STARTED" in line:
            new_session_pending = True
            continue
        m = _LINE_RE.search(line)
        if not m:
            continue
        t_ms, dev, name, rest = float(m.group(1)), m.group(2), m.group(3), m.group(4)
        fields = {}
        for part in rest.split("|"):
            if "=" in part:
                k, v = part.split("=", 1)
                fields[k.strip()] = v.strip()
        ev = {"t_ms": t_ms, "dev": dev, "name": name, "fields": fields, "rest": rest}

        starts_new = new_session_pending
        if (name == "DISCOVERED" and fields.get("n") == "0"
                and any(e["name"] == "MESH_START" for e in current)):
            starts_new = True
        if starts_new and current:
            sessions.append(current)
            current = []
        new_session_pending = False
        current.append(ev)
    if current:
        sessions.append(current)
    return sessions


def _n_peers(ev):
    try:
        return int(ev["fields"].get("n", "0"))
    except ValueError:
        return 0


def analyze_session(events):
    """Discovery and connection timing for one app launch."""
    t_start = next((e["t_ms"] for e in events if e["name"] == "MESH_START"), None)
    t_disc = next((e["t_ms"] for e in events
                   if e["name"] == "DISCOVERED" and _n_peers(e) >= 1), None)
    t_conn = next((e["t_ms"] for e in events
                   if e["name"] == "CONNECTED" and _n_peers(e) >= 1), None)
    n_req = sum(1 for e in events if e["name"] == "CONNECT_REQ")
    out = {"discovered": t_disc is not None, "connected": t_conn is not None,
           "connect_requests": n_req,
           "discovery_s": NAN, "connection_s": NAN, "mesh_to_connected_s": NAN}
    if t_start is not None and t_disc is not None:
        out["discovery_s"] = (t_disc - t_start) / 1000.0
    if t_disc is not None and t_conn is not None:
        out["connection_s"] = (t_conn - t_disc) / 1000.0
    if t_start is not None and t_conn is not None:
        out["mesh_to_connected_s"] = (t_conn - t_start) / 1000.0
    return out


# --------------------------------------------------------------------------
# Metric functions - these take plain numbers, so you can call them directly
# --------------------------------------------------------------------------

def discovery_connection_metrics(discovery_times_s, discovery_attempts,
                                 connection_times_s, connection_attempts):
    """
    Module 1: Node discovery and connection.
      discovery_times_s   list of seconds, one per attempt that found the peer
      discovery_attempts  how many attempts were made (denominator of the rate)
      connection_times_s  list of seconds, one per attempt that connected
      connection_attempts how many connection attempts were made
    """
    disc = describe(discovery_times_s)
    conn = describe(connection_times_s)
    return {
        "node_count": 2,
        "discovery_rate": rate(len(discovery_times_s), discovery_attempts),
        "discovery_time_s": disc,
        "connection_success_rate": rate(len(connection_times_s), connection_attempts),
        "connection_time_s": conn,
    }


def delay_metrics(rtts_ms=None, mean_ms=None, min_ms=None, max_ms=None,
                  echo_proc_ms=0.0):
    """
    Module 5: average end-to-end delay on one hop.
    Give either a list of RTTs (ms) or just a mean (and optionally min/max).
      one_hop_ms = (RTT - echo_proc_ms) / 2
    """
    if rtts_ms:
        d = describe(rtts_ms)
        mean, mn, mx = d["mean"], d["min"], d["max"]
        std = d["std"]
        n = d["n"]
    elif mean_ms is not None:
        mean, mn, mx, std, n = mean_ms, min_ms, max_ms, NAN, None
    else:
        return None
    one = lambda x: NAN if x is None else (x - echo_proc_ms) / 2.0
    return {
        "samples": n,
        "rtt_mean_ms": mean, "rtt_min_ms": mn if mn is not None else NAN,
        "rtt_max_ms": mx if mx is not None else NAN, "rtt_std_ms": std,
        "echo_processing_ms": echo_proc_ms,
        "one_hop_mean_ms": one(mean),
        "one_hop_min_ms": one(mn), "one_hop_max_ms": one(mx),
        "one_hop_mean_s": one(mean) / 1000.0,
    }


def pdr_metrics(sent, received):
    """Module 4: packet delivery ratio for a single hop."""
    r = rate(received, sent)
    r["loss_pct"] = 100.0 - r["pct"] if sent else NAN
    return r


def multihop_projection(p_hop, one_hop_delay_s, hops, paths=1):
    """
    Model-based multi-hop estimate from single-hop measurements.
      p_hop           single-hop delivery probability (0..1)
      one_hop_delay_s measured one-hop delay in seconds
      hops            list of hop counts, e.g. [1,2,3,4,5]
      paths           number of independent flood paths (1 = no redundancy)
    PDR = 1 - (1 - p^h)^paths     Delay = h * one_hop_delay
    """
    rows = []
    for h in hops:
        path_p = p_hop ** h
        pdr = 1.0 - (1.0 - path_p) ** paths
        rows.append({"hops": h, "paths": paths, "pdr_pct": 100 * pdr,
                     "delay_s": h * one_hop_delay_s})
    return rows


def duplicate_metrics(tp, fp, fn):
    """Module 6: duplicate / redundant report detection from counts."""
    prec = tp / (tp + fp) if (tp + fp) else NAN
    rec = tp / (tp + fn) if (tp + fn) else NAN
    f1 = 2 * tp / (2 * tp + fp + fn) if (2 * tp + fp + fn) else NAN
    return {"TP": tp, "FP": fp, "FN": fn,
            "precision_pct": 100 * prec, "recall_pct": 100 * rec,
            "f1_pct": 100 * f1, "f1": f1}


def duplicate_metrics_from_pairs(pairs):
    """pairs: iterable of (predicted_duplicate, actually_duplicate) booleans."""
    tp = fp = fn = 0
    for pred, actual in pairs:
        if pred and actual:
            tp += 1
        elif pred and not actual:
            fp += 1
        elif (not pred) and actual:
            fn += 1
    return duplicate_metrics(tp, fp, fn)


def brier_score(confidences, outcomes):
    """Module 7a: mean squared gap between confidence (0..1) and outcome (0/1)."""
    if len(confidences) != len(outcomes) or not confidences:
        return NAN
    return statistics.fmean((c - o) ** 2 for c, o in zip(confidences, outcomes))


def expected_calibration_error(confidences, outcomes, n_bins=10):
    """
    Module 7b: ECE with equal-width bins (10 bins is the standard in the
    literature). Returns (ece, bin_table). ECE is a fraction; x100 for %.
    """
    n = len(confidences)
    if n == 0 or n != len(outcomes):
        return NAN, []
    bins = [[] for _ in range(n_bins)]
    for c, o in zip(confidences, outcomes):
        idx = min(int(c * n_bins), n_bins - 1)
        bins[idx].append((c, o))
    ece, table = 0.0, []
    for i, b in enumerate(bins):
        if not b:
            continue
        conf = statistics.fmean(c for c, _ in b)
        acc = statistics.fmean(o for _, o in b)
        ece += (len(b) / n) * abs(acc - conf)
        table.append({"bin": f"{i / n_bins:.1f}-{(i + 1) / n_bins:.1f}",
                      "count": len(b), "mean_conf": conf, "accuracy": acc,
                      "gap": abs(acc - conf)})
    return ece, table


def calibration_metrics(confidences, outcomes, n_bins=10):
    ece, table = expected_calibration_error(confidences, outcomes, n_bins)
    return {"n": len(confidences), "brier": brier_score(confidences, outcomes),
            "ece": ece, "ece_pct": 100 * ece, "bins": table}


# --------------------------------------------------------------------------
# Metrics straight from log text
# --------------------------------------------------------------------------

def _flat(sessions):
    return [e for s in sessions for e in s]


def metrics_from_logs(sender_text, receiver_text=None):
    """Compute every measurable metric from the raw log text."""
    s_sessions = parse_log(sender_text)
    r_sessions = parse_log(receiver_text) if receiver_text else []
    all_sessions = s_sessions + r_sessions
    s_ev, r_ev = _flat(s_sessions), _flat(r_sessions)

    # --- module 1 ---
    per = [analyze_session(s) for s in all_sessions]
    disc_times = [p["discovery_s"] for p in per if p["discovered"] and not math.isnan(p["discovery_s"])]
    conn_times = [p["connection_s"] for p in per if p["connected"] and not math.isnan(p["connection_s"])]
    m1 = discovery_connection_metrics(disc_times, len(per), conn_times, len(per))
    m1["sessions"] = per

    # --- ping (sender side) ---
    sent, rtts, rtt_by_key = {}, [], {}
    ping_sent_keys = set()
    for e in s_ev:
        k = e["fields"].get("key")
        if e["name"] == "PING_SENT" and k:
            sent[k] = e["t_ms"]
            ping_sent_keys.add(k)
        elif e["name"] == "PONG_RECV" and k and k in sent:
            rtt = e["t_ms"] - sent[k]
            rtts.append(rtt)
            rtt_by_key[k] = rtt
    n_ping_sent = len(ping_sent_keys)

    # echo processing on receiver (PING_RECV -> PONG_SENT)
    echo, ping_recv_t = [], {}
    for e in r_ev:
        k = e["fields"].get("key")
        if e["name"] == "PING_RECV" and k:
            ping_recv_t[k] = e["t_ms"]
        elif e["name"] == "PONG_SENT" and k and k in ping_recv_t:
            echo.append(e["t_ms"] - ping_recv_t[k])
    echo_mean = statistics.fmean(echo) if echo else 0.0

    # clock offset receiver - sender
    offsets = [ping_recv_t[k] - sent[k] - rtt_by_key[k] / 2.0
               for k in rtt_by_key if k in ping_recv_t]
    offset_ms = statistics.median(offsets) if offsets else None

    m4 = pdr_metrics(n_ping_sent, len(rtts)) if n_ping_sent else None
    m5 = delay_metrics(rtts_ms=rtts, echo_proc_ms=echo_mean) if rtts else None

    # --- loss test ---
    loss_sent = {e["fields"]["key"]: e["t_ms"] for e in s_ev
                 if e["name"] == "LOSS_SENT" and "key" in e["fields"]}
    loss_recv = {e["fields"]["key"]: e["t_ms"] for e in r_ev
                 if e["name"] == "LOSS_RECV" and "key" in e["fields"]}
    loss = None
    if loss_sent or loss_recv:
        n_sent = len(loss_sent) if loss_sent else None
        n_recv = len(loss_recv)
        loss = {"sent": n_sent, "received": n_recv}
        if n_sent:
            loss["pdr"] = pdr_metrics(n_sent, n_recv)
            # truncated capture check: received keys form 1..k with k < sent
            try:
                nums = sorted(int(k.split("-")[-1]) for k in loss_recv)
                contiguous = nums == list(range(1, len(nums) + 1))
                loss["truncated_capture_suspected"] = bool(
                    contiguous and len(nums) < n_sent)
            except ValueError:
                loss["truncated_capture_suspected"] = False
        if offset_ms is not None and loss_sent:
            d = [loss_recv[k] - loss_sent[k] - offset_ms
                 for k in loss_recv if k in loss_sent]
            loss["one_way_delay_ms"] = describe(d)

    # --- processing time ---
    proc = [float(e["fields"]["ms"]) for e in s_ev + r_ev
            if e["name"] == "PROC" and "ms" in e["fields"]]

    return {"module1": m1, "module4_ping_pdr": m4, "module5_delay": m5,
            "loss_test": loss, "clock_offset_ms": offset_ms,
            "processing_ms": describe(proc) if proc else None}


# --------------------------------------------------------------------------
# Pretty printing
# --------------------------------------------------------------------------

def f(x, nd=2):
    return "n/a" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{x:.{nd}f}"


def print_rate(label, r):
    if r is None or r["n"] in (None, 0):
        print(f"  {label:<34} n/a")
        return
    print(f"  {label:<34} {f(r['pct'], 1)} %   ({r['k']}/{r['n']}, 95% CI "
          f"{f(r['ci95_low'], 1)}-{f(r['ci95_high'], 1)} %)")


def print_dist(label, d, unit):
    if not d or d["n"] == 0:
        print(f"  {label:<34} n/a")
        return
    ci = "" if math.isnan(d["ci95_half"]) else f", 95% CI +/- {f(d['ci95_half'])}"
    print(f"  {label:<34} mean {f(d['mean'])} {unit}  (std {f(d['std'])}, "
          f"min {f(d['min'])}, max {f(d['max'])}, n={d['n']}{ci})")


def print_report(R):
    print("=" * 74)
    print("MESHLINK METRICS REPORT")
    if R.get("condition"):
        print("Conditions:", R["condition"])
    print("=" * 74)

    m1 = R.get("module1")
    if m1:
        print("\n[1] NODE DISCOVERY AND CONNECTION   (node count n =", m1["node_count"], ")")
        print_rate("Node discovery rate", m1["discovery_rate"])
        print_dist("Discovery time", m1["discovery_time_s"], "s")
        print_rate("Connection success rate", m1["connection_success_rate"])
        print_dist("Connection establishment time", m1["connection_time_s"], "s")
        if m1.get("sessions"):
            print("  per launch:")
            for i, s in enumerate(m1["sessions"], 1):
                print(f"    #{i}: discovered={s['discovered']}, connected={s['connected']}, "
                      f"discovery={f(s['discovery_s'])} s, connection={f(s['connection_s'])} s, "
                      f"CONNECT_REQ={s['connect_requests']}")

    m4 = R.get("module4_ping_pdr")
    if m4 or R.get("loss_test"):
        print("\n[4] MULTI-HOP FLOOD-FILL: PDR   (measured: one hop)")
        if m4:
            print_rate("PING PDR", m4)
        lt = R.get("loss_test")
        if lt and lt.get("pdr"):
            print_rate("LOSS-test PDR", lt["pdr"])
            if lt.get("truncated_capture_suspected"):
                print("  WARNING: receiver log looks truncated (keys 1..k with no gaps, "
                      "k < sent). LOSS PDR is NOT valid; send the full receiver log.")
            if lt.get("one_way_delay_ms"):
                print_dist("One-way delay (loss packets)", lt["one_way_delay_ms"], "ms")

    m5 = R.get("module5_delay")
    if m5:
        print("\n[5] AVERAGE END-TO-END DELAY   (one hop)")
        print(f"  RTT mean                           {f(m5['rtt_mean_ms'])} ms "
              f"(min {f(m5['rtt_min_ms'])}, max {f(m5['rtt_max_ms'])}"
              f"{'' if m5['samples'] is None else ', n=' + str(m5['samples'])})")
        print(f"  Echo processing subtracted         {f(m5['echo_processing_ms'])} ms")
        print(f"  One-hop delay = (RTT - echo)/2     {f(m5['one_hop_mean_ms'])} ms "
              f"= {f(m5['one_hop_mean_s'], 5)} s")
    if R.get("clock_offset_ms") is not None:
        print(f"  Estimated clock offset (rx - tx)   {f(R['clock_offset_ms'])} ms")
    if R.get("processing_ms"):
        print_dist("Processing time (PROC)", R["processing_ms"], "ms")

    mh = R.get("multihop")
    if mh:
        print("\n[4/5] MULTI-HOP PROJECTION  (MODEL / SIMULATED, not measured)")
        print(f"  {'hops':>5} {'paths':>6} {'PDR %':>9} {'delay s':>10}")
        for r in mh:
            print(f"  {r['hops']:>5} {r['paths']:>6} {r['pdr_pct']:>9.2f} {r['delay_s']:>10.4f}")

    d = R.get("duplicates")
    if d:
        print("\n[6] DUPLICATE / REDUNDANT REPORT DETECTION")
        print(f"  TP={d['TP']}  FP={d['FP']}  FN={d['FN']}")
        print(f"  Precision                          {f(d['precision_pct'], 2)} %")
        print(f"  Recall                             {f(d['recall_pct'], 2)} %")
        print(f"  F1 score                           {f(d['f1_pct'], 2)} %   (F1 = {f(d['f1'], 4)})")

    c = R.get("calibration")
    if c:
        print("\n[7] CONFIDENCE-BASED VERIFICATION   (n =", c["n"], ")")
        print(f"  Brier score                        {f(c['brier'], 4)}   (0 = perfect, lower is better)")
        print(f"  ECE (10 bins)                      {f(c['ece'], 4)}  = {f(c['ece_pct'], 2)} %")
        if c["bins"]:
            print(f"  {'bin':<9}{'count':>6}{'mean conf':>11}{'accuracy':>10}{'gap':>8}")
            for b in c["bins"]:
                print(f"  {b['bin']:<9}{b['count']:>6}{b['mean_conf']:>11.3f}"
                      f"{b['accuracy']:>10.3f}{b['gap']:>8.3f}")
    print()


# --------------------------------------------------------------------------
# Demo - uses the values you gave me
# --------------------------------------------------------------------------

def run_demo():
    R = {"condition": "DEMO: example values typed in (no log files); "
                      "Brier/ECE inputs are illustrative placeholders"}

    # 1. discovery 2.03, 3.38, 4.25, 5.04 s over 4 attempts; connection
    #    0.39 s and 1.29 s, i.e. 2 of 4 device attempts connected
    R["module1"] = discovery_connection_metrics(
        discovery_times_s=[2.03, 3.38, 4.25, 5.04], discovery_attempts=4,
        connection_times_s=[0.39, 1.29], connection_attempts=4)

    # 4. PING PDR 96% = 48 of 50
    R["module4_ping_pdr"] = pdr_metrics(sent=50, received=48)

    # 5. RTT mean 18.3 ms (min 12.7, max 37.3); echo processing not given -> 0
    R["module5_delay"] = delay_metrics(mean_ms=18.3, min_ms=12.7, max_ms=37.3,
                                       echo_proc_ms=0.0)

    # multi-hop projection from the one-hop numbers above (model)
    R["multihop"] = (multihop_projection(0.96, R["module5_delay"]["one_hop_mean_s"],
                                         hops=[1, 2, 3, 4, 5], paths=1)
                     + multihop_projection(0.96, R["module5_delay"]["one_hop_mean_s"],
                                           hops=[3, 5], paths=2))

    # 6. F1 = 0.9143 is reproduced exactly by TP=16, FP=1, FN=2
    #    (a single F1 value alone cannot give precision/recall - you need counts)
    R["duplicates"] = duplicate_metrics(tp=16, fp=1, fn=2)

    # 7. placeholder confidences / outcomes (1 = report verified correct)
    conf = [0.95, 0.90, 0.85, 0.80, 0.75, 0.70, 0.65, 0.60, 0.55, 0.95,
            0.92, 0.88, 0.40, 0.35, 0.30, 0.97, 0.83, 0.67, 0.52, 0.25]
    outc = [1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0]
    R["calibration"] = calibration_metrics(conf, outc)
    return R


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def _read(path):
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read()


def _read_calib_csv(path):
    """CSV with two columns: confidence (0..1), correct (0/1). Header optional."""
    conf, outc = [], []
    with open(path, newline="") as fh:
        for row in csv.reader(fh):
            if len(row) < 2:
                continue
            try:
                conf.append(float(row[0]))
                outc.append(int(float(row[1])))
            except ValueError:
                continue  # header row
    return conf, outc


def main(argv=None):
    ap = argparse.ArgumentParser(description="MeshLink metrics calculator",
                                 formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog=__doc__)
    ap.add_argument("--result", action="store_true", help="run built-in example")
    ap.add_argument("--sender", help="sender log file (the phone that pressed PING/LOSS)")
    ap.add_argument("--receiver", help="receiver log file")
    ap.add_argument("--condition", default="", help='e.g. "A/B at 5 m, line of sight"')

    ap.add_argument("--disc-times", type=float, nargs="*", help="discovery times in s")
    ap.add_argument("--disc-attempts", type=int, help="number of discovery attempts")
    ap.add_argument("--conn-times", type=float, nargs="*", help="connection times in s")
    ap.add_argument("--conn-attempts", type=int, help="number of connection attempts")

    ap.add_argument("--ping-sent", type=int)
    ap.add_argument("--ping-recv", type=int)
    ap.add_argument("--rtt", type=float, nargs="*", help="list of RTTs in ms")
    ap.add_argument("--rtt-mean", type=float)
    ap.add_argument("--rtt-min", type=float)
    ap.add_argument("--rtt-max", type=float)
    ap.add_argument("--echo-proc", type=float, default=0.0, help="echo processing ms")

    ap.add_argument("--hops", type=int, nargs="*", help="hop counts for projection")
    ap.add_argument("--paths", type=int, default=1, help="independent flood paths")

    ap.add_argument("--dup-counts", type=int, nargs=3, metavar=("TP", "FP", "FN"))
    ap.add_argument("--calib-file", help="CSV: confidence,correct(0/1)")
    ap.add_argument("--json", action="store_true", help="print JSON instead of tables")
    a = ap.parse_args(argv)

    if a.result:
        R = run_demo()
    else:
        R = {"condition": a.condition}
        if a.sender:
            R.update(metrics_from_logs(_read(a.sender),
                                       _read(a.receiver) if a.receiver else None))
        if a.disc_times is not None or a.conn_times is not None:
            dt = a.disc_times or []
            ct = a.conn_times or []
            R["module1"] = discovery_connection_metrics(
                dt, a.disc_attempts or len(dt), ct, a.conn_attempts or len(ct))
        if a.ping_sent is not None and a.ping_recv is not None:
            R["module4_ping_pdr"] = pdr_metrics(a.ping_sent, a.ping_recv)
        if a.rtt or a.rtt_mean is not None:
            R["module5_delay"] = delay_metrics(a.rtt, a.rtt_mean, a.rtt_min,
                                               a.rtt_max, a.echo_proc)
        if a.hops and R.get("module5_delay") and R.get("module4_ping_pdr"):
            R["multihop"] = multihop_projection(
                R["module4_ping_pdr"]["pct"] / 100.0,
                R["module5_delay"]["one_hop_mean_s"], a.hops, a.paths)
        if a.dup_counts:
            R["duplicates"] = duplicate_metrics(*a.dup_counts)
        if a.calib_file:
            conf, outc = _read_calib_csv(a.calib_file)
            R["calibration"] = calibration_metrics(conf, outc)

    if len(R) <= 1 and not a.demo:
        ap.print_help()
        return 1
    if a.json:
        print(json.dumps(R, indent=2, default=lambda o: None))
    else:
        print_report(R)
    return 0


if __name__ == "__main__":
    sys.exit(main())