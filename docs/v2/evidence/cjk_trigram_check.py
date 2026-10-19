"""SQLite FTS5 trigram: queries shorter than 3 characters match nothing.
Most everyday Chinese words are 2 characters, so a V2 life file needs a CJK-aware
fallback (LIKE scan, bigram index, or a segmenter) for lexical recall."""
import sqlite3

c = sqlite3.connect(":memory:")
c.execute("create virtual table f using fts5(x, tokenize='trigram')")
c.executemany("insert into f values (?)", [("我今天喝了咖啡",), ("咖啡茶都喜欢",), ("下雨天气",)])
for q in ["咖啡", "咖啡茶"]:
    print("match", q, c.execute("select count(*) from f where f match ?", (q,)).fetchone()[0])
print("like 咖啡", c.execute("select count(*) from f where x like '%咖啡%'").fetchone()[0])
