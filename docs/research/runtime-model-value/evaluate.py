"""Summarize synthetic live experiments; never export prompts, headers or local config.

Usage: python evaluate.py PROTECTED_RUN_ROOT PUBLIC_OUTPUT_DIRECTORY
Objective checks run on content before variant labels are attached. This is not a
human blind review, nor an LLM judge. Missing usage/cost remains unknown.
"""
import csv
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

root, output = map(Path, sys.argv[1:])
output.mkdir(parents=True, exist_ok=True)


def save(name, value):
    (output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def check(case, text):
    if case == "published-answer-tail":
        return {"exact_fact": "松岚-852" in text}
    if case == "history-correction":
        return {"exact_facts": all(x in text for x in ["银杏-731", "海盐-926"]),
                "old_password_invalid": bool(re.search(r"作废|无效|不再有效", text))}
    if case == "long-code":
        names = set(re.findall(r"def (case_\d{3})\(", text))
        return {"nonempty_prefix": bool(text), "declared_functions": len(names),
                "all_90_functions": len(names) == 90, "python_compiles": compiles(text)}
    return {"answer_delivered": bool(text), "ambiguity_discussed": "歧义" in text}


def compiles(text):
    code = text.removeprefix("```python\n").removesuffix("```").strip()
    try:
        compile(code, "<synthetic-model-answer>", "exec")
        return True
    except (SyntaxError, ValueError):
        return False


def public_reply(value):
    return {key: item for key, item in (value or {}).items()
            if key in {"message", "answer", "finishReason", "model", "latencyMs", "tokenUsage", "error"}}


answers, file_results, measurements = [], [], []
for path in sorted(root.glob("*/model-results.json")):
    report = json.loads(path.read_text())
    run = path.parent.name
    for scenario in report.get("scenarios", []):
        if scenario.get("scenario") == "A":
            # A baseline is duplicated in the two variant rows by the harness.
            variants = [(scenario["phase"].split(":")[-1], scenario["result"])]
            if scenario["phase"].endswith(":production-character"):
                variants.append(("direct", scenario["baseline"]))
            for variant, value in variants:
                text = (value or {}).get("payload", {}).get("content", (value or {}).get("message", {}).get("content", ""))
                score = check(scenario["case"], text)  # variant not supplied to judge
                answers.append({"run": run, "case": scenario["case"], "trial": scenario["repetition"],
                                "variant": variant, "answer": text, "checks": score,
                                "error": (value or {}).get("error"),
                                "provider": (value or {}).get("payload", {}).get("provider", {}),
                                "status": report.get("status", "INCOMPLETE")})
        elif scenario.get("scenario") == "B":
            result = scenario["result"]["result"]
            answer = result.get("answer", "")
            file_results.append({"run": run, "model": report["model"], "length": scenario["length"],
                                 "expected": scenario["expectedMarkers"], "result": result,
                                 "exact_both_markers": all(x in answer for x in scenario["expectedMarkers"].values()),
                                 "reasoning_calls": len(scenario["callIndices"]),
                                 "native_no_observation": public_reply(scenario.get("noObservation")),
                                 "native_full_observation": public_reply(scenario["direct"])})
    # Include incomplete/invalid runs in cost accounting, never in valid quality rates.
    for index, call in enumerate(report.get("calls", [])):
        measurements.append({"run": run, "index": index, "phase": call["phase"], "kind": call["kind"],
                             "latency_ms": call.get("wallTimeMs"), "error": call.get("error"),
                             "reported_usage": call.get("output", {}).get("tokenUsage"),
                             "run_status": report.get("status", "INCOMPLETE")})

wire = []
for path in sorted(list(root.glob("*/wire-*.json")) + list(root.glob("*-calls/call-*.json"))):
    record = json.loads(path.read_text())
    request = record.get("effectiveInput", record.get("input")) or {}
    if not request.get("model") or "/chat/completions" not in record.get("url", ""):
        continue
    raw = record.get("output", "")
    chunks = []
    try:
        chunks = [json.loads(raw)]
    except (ValueError, TypeError):
        for line in raw.splitlines():
            if line.startswith("data:") and line[5:].strip() != "[DONE]":
                try:
                    chunks.append(json.loads(line[5:].strip()))
                except ValueError:
                    pass
    usage, finish, returned_model = {}, None, None
    for chunk in chunks:
        if chunk.get("usage"):
            usage = chunk["usage"]
        returned_model = chunk.get("model", returned_model)
        for choice in chunk.get("choices", []):
            finish = choice.get("finish_reason") or finish
    wire.append({"run": path.parent.name, "trace": path.name, "phase": record.get("phase", "server"),
                 "requested_model": request["model"], "returned_model": returned_model,
                 "temperature": request.get("temperature"), "max_tokens": request.get("max_tokens"),
                 "message_roles": ",".join(message.get("role", "unknown") for message in request.get("messages", [])),
                 "input_characters": sum(len(str(message.get("content", ""))) for message in request.get("messages", [])),
                 "http_status": record.get("httpStatus"), "latency_ms": record.get("wallTimeMs", record.get("latencyMs")),
                 "input_tokens": usage.get("prompt_tokens"), "output_tokens": usage.get("completion_tokens"),
                 "total_tokens": usage.get("total_tokens"), "cached_input_tokens": usage.get("prompt_tokens_details", {}).get("cached_tokens"),
                 "estimated_cost_usd": usage.get("estimated_cost"), "finish_reason": finish,
                 "transport_error": record.get("error"), "fallback": "none configured"})

pilot = root / "native-first.json"
if pilot.exists():
    record = json.loads(pilot.read_text())
    usage = record["output"].get("usage", {})
    wire.append({"run": "native-pilot", "trace": pilot.name, "phase": "pilot",
                 "requested_model": record["input"]["model"], "returned_model": record["output"].get("model"),
                 "temperature": None, "max_tokens": None, "message_roles": "faithful-history", "input_characters": None,
                 "http_status": 200, "latency_ms": record["latencyMs"],
                 "input_tokens": usage.get("prompt_tokens"), "output_tokens": usage.get("completion_tokens"),
                 "total_tokens": usage.get("total_tokens"), "cached_input_tokens": usage.get("prompt_tokens_details", {}).get("cached_tokens"),
                 "estimated_cost_usd": usage.get("estimated_cost"), "finish_reason": record["output"]["choices"][0].get("finish_reason"),
                 "transport_error": None, "fallback": record["fallback"]})

save("memory-results.json", [{"run": path.stem, "turns": [
    {"question": row["input"]["text"], "http_status": row["status"],
     "answer": row["output"].get("payload", {}).get("content", row["output"].get("content", row["output"].get("reply"))),
     "transport_error": row["output"].get("transportError"),
     "retrieval_status": row["output"].get("promptPreview", {}).get("memoryProviderStatus"),
     "retrieved_count": row["output"].get("promptPreview", {}).get("retrievedMemoryCount"),
     "extractor": row["output"].get("promptPreview", {}).get("memoryExtractorActive"),
     "candidates": row["output"].get("promptPreview", {}).get("memoryExtractionCandidateCount"),
     "write_status": row["output"].get("promptPreview", {}).get("memoryWriteStatus"),
     "latency_ms": row["latencyMs"]}
    for row in json.loads(path.read_text()) if row["path"] == "/message"
]} for path in sorted(root.glob("*-server-results*.json"))])

save("synthetic-answers.json", answers)
save("file-results.json", file_results)
save("application-calls.json", measurements)
save("wire-measurements.json", wire)
with (output / "model-calls.csv").open("w", newline="") as stream:
    writer = csv.DictWriter(stream, fieldnames=list(wire[0]) if wire else [])
    writer.writeheader()
    writer.writerows(wire)
groups = defaultdict(list)
for row in answers:
    if row["status"] == "LIVE_RUN_COMPLETE_UNRATED":
        groups[(row["run"], row["case"], row["variant"])].append(row)
rates = [{"run": key[0], "case": key[1], "variant": key[2], "samples": len(rows),
          "delivered": sum(bool(row["answer"]) for row in rows),
          "exact_fact_passes": sum(row["checks"].get("exact_fact", row["checks"].get("exact_facts", False)) for row in rows),
          "mean_chars": sum(len(row["answer"]) for row in rows) / len(rows)} for key, rows in groups.items()]
save("objective-results.json", rates)
save("accounting.json", {
    "captured_wire_requests": len(wire),
    "captured_application_calls": len(measurements),
    "input_tokens_with_usage": sum(row["input_tokens"] or 0 for row in wire),
    "output_tokens_with_usage": sum(row["output_tokens"] or 0 for row in wire),
    "provider_estimated_cost_usd": sum(float(row["estimated_cost_usd"] or 0) for row in wire),
    "requests_missing_cost": sum(row["estimated_cost_usd"] is None for row in wire),
    "application_errors": sum(bool(row["error"]) for row in measurements),
    "application_calls_with_unknown_cost": [row for row in measurements if row["error"] and row["error"].get("code") == "TIMEOUT"],
    "limits": ["Provider estimates are not invoices; missing or interrupted usage is UNKNOWN.",
               "Concurrent invalid pilot files may have overwritten records: total cost is a lower bound.",
               "Local embedding/Mem0 resources are not included in remote model cost.",
               "Objective label-hidden checks are not human blind review or broad semantic quality scores."]
})
