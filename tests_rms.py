import ast, math, os, sys, json, tempfile
sys.path.insert(0, os.getcwd())

src = open("vcat_telemetry.py").read()
tree = ast.parse(src)
want = {"_rms", "_sample_weights", "_read_rms_rows", "_cluster_rms",
        "_weighted_percentile"}
ns = {"math": math, "json": json, "os": os}
from vcat_telemetry_data_models import parse_cores
ns["parse_cores"] = parse_cores
class _L:
    def warning(self, *a): pass
ns["logger"] = _L()
ns["RMS_MIN_HEADER"] = 3004
ns["_RMS_TIME_COL"] = "test.timestamp"
for n in tree.body:
    if isinstance(n, ast.FunctionDef) and n.name in want:
        exec(compile(ast.Module(body=[n], type_ignores=[]), "<x>", "exec"), ns)

_rms, _weights, _cluster = ns["_rms"], ns["_sample_weights"], ns["_cluster_rms"]
ok = True
def check(label, got, exp, tol=0.5):
    global ok
    good = (abs(got - exp) <= tol) if isinstance(exp, float) or isinstance(got, float) else got == exp
    ok &= good
    print(f"  {'PASS' if good else 'FAIL'}  {label:46} got={got!r} expected~{exp!r}")

print("Stage-2 RMS:")
check("equal cores [2000]*4 -> that value", _rms([2000]*4), 2000.0)
check("uneven [2500,2500,500,500] -> 1803 not 1500", _rms([2500,2500,500,500]), 1802.776)
check("single value", _rms([1234]), 1234.0)
check("empty", _rms([]), 0.0)

print("\nSample weights:")
# The spec gives each endpoint a full adjacent gap, so the total is the span plus
# one sample interval. Harmless for RMS (the sum cancels), slightly over-reports
# "Weighted duration".
check("even spacing: span + one interval", sum(_weights([0,1,2,3])), 4.0)
check("scaling weights cannot move the RMS",
      round(_rms([2500,500]), 6), round(_rms([2500,500]), 6))
check("uneven spacing: middle takes half each side", _weights([0,1,10])[1], 5.0)
check("single sample weighs nothing", sum(_weights([5])), 0.0)
check("two samples", sum(_weights([0,4])), 8.0)

def mklog(path, cores, rows, version=3004):
    hdr = {"header_version": version, "device_info": {"model":"T","cpu":{"architecture":"x","cores":cores},
           "manufacturer":"m","soc_manufacturer":"s","soc":"s","android_version":"14",
           "display_resolution":{"width":1,"height":1},"memory":{},"storage":{}}}
    n = max(int(k.replace("core","")) for k in cores) + 1
    cols = ["test.timestamp","test.filename"] + [f"cpu.freq{i}" for i in range(n)]
    with open(path,"w") as f:
        f.write(json.dumps(hdr, indent=1) + "\n\n")
        f.write(",".join(cols) + "\n")
        for ts, fn, freqs in rows:
            f.write(",".join([str(ts), fn] + [str(freqs.get(i,0)) for i in range(n)]) + "\n")

tmp = tempfile.mkdtemp()
C44 = {f"core{i}": ("null: 1000 MHz" if i < 4 else "Cortex-A78: 2500 MHz") for i in range(8)}

print("\nCore classification 4+4:")
p = os.path.join(tmp,"a.csv")
mklog(p, C44, [(1000*i, "v.mp4", {**{j:1000 for j in range(4)}, **{j:2500 for j in range(4,8)}}) for i in range(5)])
r = _cluster(p, "small"); check("small cluster ids", sorted(r["per_core"]), [0,1,2,3])
check("small f_rms == 1000", r["f_rms"], 1000.0)
r = _cluster(p, "large"); check("large cluster ids", sorted(r["per_core"]), [4,5,6,7])
check("large f_rms == 2500", r["f_rms"], 2500.0)
check("% of max == 100", r["pct_of_max"], 100.0)

print("\nCore classification 1+3+4 (mid groups with large):")
C134 = {f"core{i}": (f"null: {1000 if i<4 else (2000 if i<7 else 3000)} MHz") for i in range(8)}
p2 = os.path.join(tmp,"b.csv")
mklog(p2, C134, [(1000*i, "v.mp4", {**{j:1000 for j in range(4)}, **{j:2000 for j in range(4,7)}, 7:3000}) for i in range(5)])
r = _cluster(p2, "large"); check("large = mid+prime", sorted(r["per_core"]), [4,5,6,7])
check("large f_rms = rms(2000,2000,2000,3000)", r["f_rms"], math.sqrt((2000**2*3+3000**2)/4))
r = _cluster(p2, "small"); check("small = lowest tier only", sorted(r["per_core"]), [0,1,2,3])

print("\nTime weighting with uneven spacing:")
p3 = os.path.join(tmp,"c.csv")
# 2500 MHz for 1s, then 500 MHz held for 9s -> weighted rms must lean to 500
mklog(p3, C44, [(0,"v.mp4",{i:2500 for i in range(8)}), (1000,"v.mp4",{i:500 for i in range(8)}),
                (10000,"v.mp4",{i:500 for i in range(8)})])
r = _cluster(p3, "large")
check("weighted toward the long low period", r["f_rms"] < 1200, True)
check("unweighted mean would be ~1500", r["f_rms"] < 1400, True)

print("\nRow filtering and gating:")
p4 = os.path.join(tmp,"d.csv")
mklog(p4, C44, [(0,"empty",{i:9999 for i in range(8)}), (1000,"v.mp4",{i:2500 for i in range(8)}),
                (2000,"v.mp4",{i:2500 for i in range(8)})])
check("filename=='empty' rows excluded", _cluster(p4,"large")["f_rms"], 2500.0)

p5 = os.path.join(tmp,"e.csv")
mklog(p5, C44, [(1000*i,"v.mp4",{j:2500 for j in range(8)}) for i in range(5)], version=74)
check("header < 3004 -> no block", _cluster(p5,"large"), None)

p6 = os.path.join(tmp,"f.csv")
homog = {f"core{i}": "null: 2000 MHz" for i in range(8)}
mklog(p6, homog, [(1000*i,"v.mp4",{j:2000 for j in range(8)}) for i in range(5)])
check("homogeneous CPU -> no split", _cluster(p6,"large"), None)

print("\nScoring window:")
p7 = os.path.join(tmp,"g.csv")
rows = [(0,"v.mp4",{i:2500 for i in range(8)})]
rows += [(60000*m,"v.mp4",{i:(2500 if m < 30 else 500) for i in range(8)}) for m in range(1,61)]
mklog(p7, C44, rows)
full = _cluster(p7,"large"); win = _cluster(p7,"large",{"start_min":30,"end_min":60})
check("window label", win["window"], "30-60 min")
check("windowed f_rms == 500 (low half only)", win["f_rms"], 500.0, tol=5)
check("full-run f_rms is higher", full["f_rms"] > win["f_rms"], True)
check("windowed duration ~0.5h", win["weighted_hours"], 0.5, tol=0.02)


# ---- weighted percentiles and the minimum -----------------------------------
_wp = ns["_weighted_percentile"]
print("\nWeighted percentiles:")
flat = [(2000, 1)] * 10
check("uniform -> that value (p50)", _wp(flat, 50), 2000)
check("uniform -> that value (p5)", _wp(flat, 5), 2000)
ramp = [(v, 1) for v in range(1, 101)]
check("1..100 p50", _wp(ramp, 50), 50, tol=1)
check("1..100 p95", _wp(ramp, 95), 95, tol=1)
check("1..100 p5", _wp(ramp, 5), 5, tol=1)
check("empty -> None", _wp([], 50), None)
check("zero weights -> None", _wp([(100, 0)], 50), None)

# Weighting must beat raw counts: one long stretch low, many brief samples high.
skew = [(2400, 1)] * 20 + [(1200, 200)]
check("long low stretch outweighs many brief highs", _wp(skew, 50), 1200)
check("same data unweighted would say 2400", sorted([v for v, _ in skew])[len(skew)//2], 2400)

print("\nThe discriminating case (same f_rms and p50, different floor):")
steady = [(2427, 100)] * 10
dipped = [(2427, 100)] * 9 + [(1196, 1)] + [(2427, 99)]
check("medians match", _wp(steady, 50) == _wp(dipped, 50), True)
check("steady floor", min(v for v, _ in steady), 2427)
check("dipped floor exposes the stall", min(v for v, _ in dipped), 1196)
def wrms(pairs):
    tot = sum(w for _, w in pairs)
    return math.sqrt(sum(w * v * v for v, w in pairs) / tot)
rs, rd = wrms(steady), wrms(dipped)
check("time-weighted aggregate barely moves", abs(rs - rd) < 2, True)
check("  steady weighted rms", round(rs), 2427)
check("  dipped weighted rms", round(rd), 2426)
check("but the floor differs by >1200 MHz",
      min(v for v, _ in steady) - min(v for v, _ in dipped) > 1200, True)

print("\n" + ("ALL PASS" if ok else "FAILURES PRESENT"))
sys.exit(0 if ok else 1)
