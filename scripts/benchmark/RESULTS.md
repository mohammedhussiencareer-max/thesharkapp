# Accounting history benchmark

Synthetic catalog. Each history ends yesterday: past orders are frozen activation inputs and post on their own day. The measured order is a new order today, timed by a top-level statement after the session statement timeout is set to 6 seconds. Its probe is read before any later restore. A selective restore and a large-share restore are timed on their own, and each keeps the plan and buffers of the restore insert that ran inside that call. Every measured call must resume from a checkpoint. A sequence scan of about half the deficit table is accepted. The restore gate is latency (2 seconds soft, 6 seconds hard), shared hit plus read pages below 5000, and a frozen prefix that is not walked. The measured order suffix arms must be index scans on their own. The aged cover is record_purchase, the production purchase RPC. Daily fish counts and weekly counts are anchors. Checkpoints are published by the confirming walk. --resume is supported only before measurement starts; a committed measurement needs `pnpm db:reset` and a rerun. The sort-traversal case holds suffix and open deficits fixed while a frozen mixed/size sort history grows (35-day, 1-year, 2-year, at least one sort per day). Its gate is the whole RPC shared hit plus read pages below 5000 and 2 seconds, and those buffers must stay flat as the frozen history grows.

## 35-day

- orders: 3500
- days: 35
- posted historical orders with a posting receipt and movements: 3500
- eligible replay rows before the measured call: 3503
- stock_count_anchors: 35
- weekly anchors: 5
- events plus anchors: 3538
- queue depth 1 ms: 0.476
- queue depth 50000 ms: 0.526
- suffix index range: true
- suffix rows: 4
- time arm rows: 2
- id arm rows: 2
- time arm index: true
- id arm index: true
- confirming replay ms: 14.919
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
- wall clock seconds: 0.064
- crossed 2s: false
- aged cover seconds: 0.018
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
- queue depth 1 ms: 5.792
- queue depth 50000 ms: 5.794
- suffix index range: true
- suffix rows: 4
- time arm rows: 2
- id arm rows: 2
- time arm index: true
- id arm index: true
- confirming replay ms: 29.761
- prefix rows: 0
- resumed from checkpoint: true
- shared hit+read limit: 5000
- fresh buffers: 4
- selective restore seconds: 0.01
- selective restore crossed 2s: false
- selective prefix rows: 0
- selective deficit rows: 1
- selective buffers: 10
- selective resumed: true
- large-share restore seconds: 0.022
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
- wall clock seconds: 0.108
- crossed 2s: false
- aged cover seconds: 0.029
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
- queue depth 1 ms: 12.781
- queue depth 50000 ms: 11.488
- suffix index range: true
- suffix rows: 4
- time arm rows: 2
- id arm rows: 2
- time arm index: true
- id arm index: true
- confirming replay ms: 135.016
- prefix rows: 0
- resumed from checkpoint: true
- shared hit+read limit: 5000
- fresh buffers: 4
- selective restore seconds: 0.012
- selective restore crossed 2s: false
- selective prefix rows: 0
- selective deficit rows: 1
- selective buffers: 10
- selective resumed: true
- large-share restore seconds: 0.027
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
- wall clock seconds: 0.326
- crossed 2s: false
- aged cover seconds: 0.088
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
- shared hit+read limit: 5000
- rpc buffers: 4583
- rpc seconds: 0.027
- crossed 2s: false
- gate: PASS

## 1-year sorts

- days: 365
- frozen sorts: 365
- suffix movements: 1
- open deficits: 3
- resumed from checkpoint: true
- shared hit+read limit: 5000
- rpc buffers: 4413
- rpc seconds: 0.027
- crossed 2s: false
- gate: PASS

## 2-year sorts

- days: 730
- frozen sorts: 730
- suffix movements: 1
- open deficits: 3
- resumed from checkpoint: true
- shared hit+read limit: 5000
- rpc buffers: 4473
- rpc seconds: 0.031
- crossed 2s: false
- gate: PASS

The 35-day, 1-year, and 2-year histories passed the gate. --resume is supported only before measurement starts. A committed measurement needs pnpm db:reset and a rerun. Sort-traversal RPC buffers stayed flat: 35-day sorts 4583 buffers / 0.027s; 1-year sorts 4413 buffers / 0.027s; 2-year sorts 4473 buffers / 0.031s.
