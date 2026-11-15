# Accounting history benchmark

Synthetic catalog. Orders start on 2026-11-15 so each one is inside the restatement window, including dates after today. Historical orders were posted with `app.run_accounting_work`. The measured order is a new queue head, timed by a top-level statement after the session statement timeout is set to 6 seconds. The soft gate is 2 seconds and the hard gate is 6 seconds. The pass also requires both suffix arms of that read to be index scans of stock_movements, and a later confirming replay to restore at least 1000 deficits. Daily fish counts and weekly counts are anchors. Checkpoints are published by the confirming walk. The earlier 0.785 s two-year figure was measured before the cover path and the closed-period walk, and its suffix query ran after publish so it saw 0 rows.

## 35-day

- orders: 3500
- days: 35
- posted historical orders with a posting receipt and movements: 3500
- eligible replay rows before the measured call: 3503
- stock_count_anchors: 35
- weekly anchors: 5
- events plus anchors: 3538
- queue depth 1 ms: 0.237
- queue depth 50000 ms: 0.313
- suffix index range: true
- suffix rows: 0
- deficit restore rows: 1
- measured status: processed
- failed: 0
- completion outcome: applied
- receipt_kind: posting
- per-item movement links match negated requirements: true
- split normal and provisional: true
- wall clock seconds: 0.081
- crossed 2s: false
- gate: PASS

## 1-year

- orders: 36500
- days: 365
- posted historical orders with a posting receipt and movements: 36500
- eligible replay rows before the measured call: 36503
- stock_count_anchors: 365
- weekly anchors: 52
- events plus anchors: 36868
- queue depth 1 ms: 0.472
- queue depth 50000 ms: 0.232
- suffix index range: true
- suffix rows: 4
- time arm rows: 2
- id arm rows: 2
- time arm index: true
- id arm index: true
- confirming replay ms: 70.992
- deficit restore rows: 1002
- deficit restore index: true
- measured status: processed
- failed: 0
- completion outcome: applied
- receipt_kind: posting
- per-item movement links match negated requirements: true
- split normal and provisional: true
- wall clock seconds: 0.171
- crossed 2s: false
- gate: PASS

## 2-year

- orders: 73000
- days: 730
- posted historical orders with a posting receipt and movements: 73000
- eligible replay rows before the measured call: 73003
- stock_count_anchors: 730
- weekly anchors: 104
- events plus anchors: 73733
- queue depth 1 ms: 0.236
- queue depth 50000 ms: 0.196
- suffix index range: true
- suffix rows: 4
- time arm rows: 2
- id arm rows: 2
- time arm index: true
- id arm index: true
- confirming replay ms: 146.794
- deficit restore rows: 1002
- deficit restore index: true
- measured status: processed
- failed: 0
- completion outcome: applied
- receipt_kind: posting
- per-item movement links match negated requirements: true
- split normal and provisional: true
- wall clock seconds: 0.42
- crossed 2s: false
- gate: PASS

The 35-day, 1-year, and 2-year histories passed the gate.
