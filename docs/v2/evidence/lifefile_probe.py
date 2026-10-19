"""V2 feasibility probe: can one SQLite file hold a multi-year life log?
Synthetic data only. Measures insert, size, FTS5 (trigram) search, recent-window
read, brute-force vector search, and fork (file copy) cost."""
import json, os, random, shutil, sqlite3, statistics, sys, time
import numpy as np

N = int(sys.argv[1]) if len(sys.argv) > 1 else 1_000_000
DB = f"life_{N}.sqlite"
random.seed(7); np.random.seed(7)
ZH = list("我你他她们今天明天昨天想觉得喜欢讨厌论文代码项目音乐电影咖啡茶散步下雨天气工作学校考试朋友群聊消息图片记得忘记为什么因为所以但是还有一起看看试试")
EN = "the a we you think paper code music rain coffee group remember forget why because test model memory life time".split()
def text():
    if random.random() < 0.7:
        return "".join(random.choice(ZH) for _ in range(random.randint(4, 80)))
    return " ".join(random.choice(EN) for _ in range(random.randint(3, 30)))
KINDS = ["heard", "said", "silent", "saw", "reflected", "tool_result"]
ACTORS = ["user:creator", "yuvi", "qq:1001", "qq:1002", "qq:1003", "system"]
SCENES = ["desktop", "qq:group:42", "qq:group:77", "qq:private:1001", "self"]

if os.path.exists(DB): os.remove(DB)
c = sqlite3.connect(DB)
c.executescript("""
pragma journal_mode=wal; pragma synchronous=normal;
create table events(
  seq integer primary key, id text unique not null, t_observed integer not null,
  kind text not null, actor text not null, scene text not null, reply_to text,
  content text, epistemic text not null, meta text);
create index ev_scene_seq on events(scene, seq);
create virtual table events_fts using fts5(content, content='events', content_rowid='seq', tokenize='trigram');
""")
t0 = time.perf_counter(); t = 1_760_000_000; batch = []
for i in range(N):
    t += random.randint(1, 120)
    k = random.choice(KINDS)
    batch.append((i + 1, f"ev_{i+1:08d}", t, k, random.choice(ACTORS), random.choice(SCENES),
                  f"ev_{max(1, i - random.randint(1, 5)):08d}" if random.random() < .3 else None,
                  text(), "self_act" if k in ("said", "silent", "reflected") else "observation",
                  json.dumps({"model": "m1"}) if k == "reflected" else None))
    if len(batch) == 20_000:
        with c:
            c.executemany("insert into events values (?,?,?,?,?,?,?,?,?,?)", batch)
            c.executemany("insert into events_fts(rowid, content) values (?, ?)", [(b[0], b[7]) for b in batch])
        batch = []
if batch:
    with c:
        c.executemany("insert into events values (?,?,?,?,?,?,?,?,?,?)", batch)
        c.executemany("insert into events_fts(rowid, content) values (?, ?)", [(b[0], b[7]) for b in batch])
ins = time.perf_counter() - t0
c.execute("pragma wal_checkpoint(truncate)")
size = os.path.getsize(DB)

def lat(fn, n=50):
    xs = []
    for _ in range(n):
        s = time.perf_counter(); fn(); xs.append((time.perf_counter() - s) * 1000)
    xs.sort(); return round(statistics.median(xs), 2), round(xs[int(len(xs) * .95) - 1], 2)

qs = ["论文代码", "一起看看", "咖啡", "remember", "music rain", "考试朋友"]
fts = {q: lat(lambda q=q: c.execute("select rowid from events_fts where events_fts match ? order by rank limit 20", ('"'+q+'"',)).fetchall(), 15) for q in qs + ["咖啡茶", "下雨天气"]}
recent = lat(lambda: c.execute("select * from events order by seq desc limit 2000").fetchall())
scene = lat(lambda: c.execute("select * from events where scene=? order by seq desc limit 500", (random.choice(SCENES),)).fetchall())

V = min(N, 200_000)
vecs = np.random.randn(V, 512).astype(np.float32); vecs /= np.linalg.norm(vecs, axis=1, keepdims=True)
def vsearch():
    q = np.random.randn(512).astype(np.float32); q /= np.linalg.norm(q)
    s = vecs @ q; np.argpartition(-s, 10)[:10]
vec = lat(vsearch, 30)

c.close()
s = time.perf_counter(); shutil.copyfile(DB, DB + ".fork"); fork = time.perf_counter() - s
os.remove(DB + ".fork")
print(json.dumps({"events": N, "insert_s": round(ins, 1), "file_mb": round(size / 1e6, 1),
                  "fts_trigram_ms_p50_p95": fts, "recent2000_ms_p50_p95": recent,
                  "scene500_ms_p50_p95": scene, "vectors": V, "vec_bruteforce_ms_p50_p95": vec,
                  "fork_copy_s": round(fork, 2), "sqlite": sqlite3.sqlite_version}, ensure_ascii=False))
os.remove(DB)
for ext in ("-wal", "-shm"):
    if os.path.exists(DB + ext): os.remove(DB + ext)
