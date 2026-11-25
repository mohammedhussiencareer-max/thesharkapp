# Accounting history benchmark

Synthetic catalog. Each history ends yesterday: past orders are frozen activation inputs and post on their own day. The measured order is a new order today, timed by a top-level statement after the session statement timeout is set to 6 seconds. Its probe is read before any later restore. A selective restore and a large-share restore are timed on their own, and each keeps the plan and buffers of the restore insert that ran inside that call. Every measured call must resume from a checkpoint. A sequence scan of about half the deficit table is accepted. The restore gate is latency (2 seconds soft, 6 seconds hard), shared hit plus read pages below 5000, and a frozen prefix that is not walked. The measured order suffix arms must be index scans on their own. The aged cover is record_purchase, the production purchase RPC. Daily fish counts and weekly counts are anchors. Checkpoints are published by the confirming walk. --resume is supported only before measurement starts; a committed measurement needs `pnpm db:reset` and a rerun. The sort-traversal case holds suffix and open deficits fixed while a frozen mixed/size sort history grows (35-day, 1-year, 2-year, at least one sort per day). Each sort-traversal RPC measurement runs after a rolled-back warmup record_purchase on the same session, so its reported buffers and seconds are warmed steady-state figures (not like-for-like with earlier cold-backend figures). Its gate is the whole RPC shared hit plus read pages below 5000 and 2 seconds, and the 2-year case may use at most 10% more buffers than the 35-day case.

## 35-day

- orders: 3500
- days: 35
- posted historical orders with a posting receipt and movements: 3500
- eligible replay rows before the measured call: 3503
- stock_count_anchors: 35
- weekly anchors: 5
- events plus anchors: 3538
- queue depth 1 ms: 0.496
- queue depth 50000 ms: 0.529
- suffix index range: true
- suffix rows: 4
- time arm rows: 2
- id arm rows: 2
- time arm index: true
- id arm index: true
- confirming replay ms: 17.606
- prefix rows: 0
- resumed from checkpoint: true
- shared hit+read limit: 5000
- fresh buffers: 3
- selective restore seconds: 0.01
- selective restore crossed 2s: false
- selective prefix rows: 0
- selective deficit rows: 1
- selective buffers: 9
- selective resumed: true
- large-share restore seconds: 0.014
- large-share restore crossed 2s: false
- large-share prefix rows: 0
- large-share deficit rows: 201
- large-share buffers: 426
- large-share resumed: true
- large-share table rows: 402
- measured status: processed
- failed: 0
- completion outcome: applied
- receipt_kind: posting
- per-item movement links match negated requirements: true
- split normal and provisional: true
- wall clock seconds: 0.07
- crossed 2s: false
- aged cover seconds: 0.021
- aged cover crossed 2s: false
- aged prefix rows: 0
- aged deficit rows: 1
- aged buffers: 11
- aged resumed: true
- aged deficit covered: true
- gate: PASS

## 1-year

- orders: 36500
- days: 365
- posted historical orders with a posting receipt and movements: 36500
- eligible replay rows before the measured call: 36503
- stock_count_anchors: 365
- weekly anchors: 52
- events plus anchors: 36868
- queue depth 1 ms: 5.961
- queue depth 50000 ms: 5.733
- suffix index range: true
- suffix rows: 4
- time arm rows: 2
- id arm rows: 2
- time arm index: true
- id arm index: true
- confirming replay ms: 33.86
- prefix rows: 0
- resumed from checkpoint: true
- shared hit+read limit: 5000
- fresh buffers: 4
- selective restore seconds: 0.011
- selective restore crossed 2s: false
- selective prefix rows: 0
- selective deficit rows: 1
- selective buffers: 10
- selective resumed: true
- large-share restore seconds: 0.02
- large-share restore crossed 2s: false
- large-share prefix rows: 0
- large-share deficit rows: 404
- large-share buffers: 840
- large-share resumed: true
- large-share table rows: 808
- measured status: processed
- failed: 0
- completion outcome: applied
- receipt_kind: posting
- per-item movement links match negated requirements: true
- split normal and provisional: true
- wall clock seconds: 0.102
- crossed 2s: false
- aged cover seconds: 0.037
- aged cover crossed 2s: false
- aged prefix rows: 0
- aged deficit rows: 1
- aged buffers: 11
- aged resumed: true
- aged deficit covered: true
- gate: PASS

## 2-year

- orders: 73000
- days: 730
- posted historical orders with a posting receipt and movements: 73000
- eligible replay rows before the measured call: 73003
- stock_count_anchors: 730
- weekly anchors: 104
- events plus anchors: 73733
- queue depth 1 ms: 11.062
- queue depth 50000 ms: 11.875
- suffix index range: true
- suffix rows: 4
- time arm rows: 2
- id arm rows: 2
- time arm index: true
- id arm index: true
- confirming replay ms: 118.875
- prefix rows: 0
- resumed from checkpoint: true
- shared hit+read limit: 5000
- fresh buffers: 4
- selective restore seconds: 0.013
- selective restore crossed 2s: false
- selective prefix rows: 0
- selective deficit rows: 1
- selective buffers: 10
- selective resumed: true
- large-share restore seconds: 0.025
- large-share restore crossed 2s: false
- large-share prefix rows: 0
- large-share deficit rows: 810
- large-share buffers: 2082
- large-share resumed: true
- large-share table rows: 1620
- measured status: processed
- failed: 0
- completion outcome: applied
- receipt_kind: posting
- per-item movement links match negated requirements: true
- split normal and provisional: true
- wall clock seconds: 0.281
- crossed 2s: false
- aged cover seconds: 0.077
- aged cover crossed 2s: false
- aged prefix rows: 0
- aged deficit rows: 1
- aged buffers: 9
- aged resumed: true
- aged deficit covered: true
- gate: PASS

## 35-day sorts

- days: 35
- frozen sorts: 35
- suffix movements: 1
- open deficits: 3
- resumed from checkpoint: true
- checkpoint ID: 4
- checkpoint cut: 2026-11-25T10:00:00+00:00
- session warmup: rolled-back record_purchase (warmed)
- shared hit+read limit: 5000
- warmed rpc buffers: 1693
- warmed rpc seconds: 0.015
- crossed 2s: false
- gate: PASS

## 1-year sorts

- days: 365
- frozen sorts: 365
- suffix movements: 1
- open deficits: 3
- resumed from checkpoint: true
- checkpoint ID: 10
- checkpoint cut: 2026-11-25T10:00:00+00:00
- session warmup: rolled-back record_purchase (warmed)
- shared hit+read limit: 5000
- warmed rpc buffers: 1664
- warmed rpc seconds: 0.016
- crossed 2s: false
- gate: PASS

## 2-year sorts

- days: 730
- frozen sorts: 730
- suffix movements: 1
- open deficits: 3
- resumed from checkpoint: true
- checkpoint ID: 16
- checkpoint cut: 2026-11-25T10:00:00+00:00
- session warmup: rolled-back record_purchase (warmed)
- shared hit+read limit: 5000
- warmed rpc buffers: 1556
- warmed rpc seconds: 0.014
- crossed 2s: false
- gate: PASS

The 35-day, 1-year, and 2-year histories passed the gate. --resume is supported only before measurement starts. A committed measurement needs pnpm db:reset and a rerun. Sort-traversal warmed RPC buffers stayed flat within 10%: 35-day sorts 1693 warmed buffers / 0.015s; 1-year sorts 1664 warmed buffers / 0.016s; 2-year sorts 1556 warmed buffers / 0.014s.
