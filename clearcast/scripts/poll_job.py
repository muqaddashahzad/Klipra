"""Submit a file to the running Clearcast server and poll till done.
Usage: poll_job.py <file> <engine> <remove_music true|false> [strength]"""
import json
import sys
import time

import requests

BASE = "http://127.0.0.1:8765"
f, engine, music = sys.argv[1], sys.argv[2], sys.argv[3]
strength = sys.argv[4] if len(sys.argv) > 4 else "1.0"

with open(f, "rb") as fh:
    r = requests.post(
        BASE + "/api/enhance",
        files={"file": fh},
        data={"engine": engine, "remove_music": music,
              "strength": strength, "warmth": "0.6", "output_format": "wav"},
    )
r.raise_for_status()
jid = r.json()["job_id"]
print(f"job {jid}  (engine={engine}, remove_music={music})")

last, t0 = None, time.time()
while True:
    s = requests.get(f"{BASE}/api/status/{jid}").json()
    key = (s.get("stage"), round(s.get("progress", 0), 2))
    if key != last:
        print(f"  {time.time()-t0:5.0f}s  {s.get('status'):10} {s.get('progress',0):4.2f}  "
              f"{str(s.get('stage')):9} {s.get('message')}")
        last = key
    if s.get("status") == "done":
        print("META:", json.dumps(s.get("meta", {}), indent=2))
        print("JOBID", jid)
        break
    if s.get("status") == "error":
        print("ERROR:\n", s.get("error"))
        sys.exit(1)
    if time.time() - t0 > 1500:
        print("client timeout (job still running server-side)")
        break
    time.sleep(2)
