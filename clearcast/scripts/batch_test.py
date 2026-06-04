"""Submit several files at once and verify they process ONE AT A TIME."""
import sys
import time

import requests

BASE = "http://127.0.0.1:8765"
ENGINE = sys.argv[1] if len(sys.argv) > 1 else "basic"
FILES = sys.argv[2:] or [
    "jobs/_sample/test_noisy.wav",
    "jobs/_sample/enhanced_studio.wav",
    "jobs/_sample/test_video.mp4",
]

jobs = []
for f in FILES:
    with open(f, "rb") as fh:
        r = requests.post(BASE + "/api/enhance", files={"file": fh},
                          data={"engine": ENGINE, "remove_music": "false"})
    jid = r.json()["job_id"]
    jobs.append({"file": f.split("/")[-1], "jid": jid})
    print(f"submitted {f.split('/')[-1]:26} -> {jid}")

print("\n  t     " + "  ".join(f"{j['file'][:14]:14}" for j in jobs) + "   #processing")
t0 = time.time()
max_concurrent = 0
seen_video = {}
while True:
    states, procs = [], 0
    for j in jobs:
        s = requests.get(f"{BASE}/api/status/{j['jid']}").json()
        st = s["status"]
        if st == "processing":
            procs += 1
            states.append(f"{int(s.get('progress',0)*100):>3}%proc    ")
        elif st == "queued":
            states.append(f"queued({s.get('ahead',0)})    ")
        elif st == "done":
            states.append(f"DONE{'+vid' if s.get('has_video') else '    '}    ")
            seen_video[j["jid"]] = s.get("has_video")
        else:
            states.append("ERROR        ")
    max_concurrent = max(max_concurrent, procs)
    print(f" {time.time()-t0:4.0f}s  " + "  ".join(s[:14] for s in states) + f"   {procs}")
    if all(requests.get(f"{BASE}/api/status/{j['jid']}").json()["status"] in ("done", "error") for j in jobs):
        break
    if time.time() - t0 > 600:
        print("timeout"); break
    time.sleep(1.0)

print(f"\nMAX SIMULTANEOUS 'processing' = {max_concurrent}  "
      f"({'PASS: strictly sequential' if max_concurrent <= 1 else 'FAIL: ran in parallel'})")
# verify video download
for j in jobs:
    if seen_video.get(j["jid"]):
        rv = requests.get(f"{BASE}/api/download/{j['jid']}/video")
        print(f"video download for {j['file']}: HTTP {rv.status_code}, {len(rv.content)} bytes")
