# Phase 11 Plan 11-00 — Wave 0 Schema Verification

Date: 2026-04-26
Connection: dashboard_api @ localhost:55432 (SSM port-forward via i-0c1ee4fefaf1448ce)
Direct RDS endpoint: kosdata-rdsinstance5075e838-9prpmgxajujc.cts46s6u6r3l.eu-north-1.rds.amazonaws.com

---

## a) agent_runs schema (Open Q1)
                                                                         Table "public.agent_runs"
       Column        |           Type           | Collation | Nullable |                   Default                    | Storage  | Compression | Stats target | Description 
---------------------+--------------------------+-----------+----------+----------------------------------------------+----------+-------------+--------------+-------------
 id                  | uuid                     |           | not null | gen_random_uuid()                            | plain    |             |              | 
 owner_id            | uuid                     |           | not null | '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid | plain    |             |              | 
 capture_id          | text                     |           |          |                                              | extended |             |              | 
 agent_name          | text                     |           | not null |                                              | extended |             |              | 
 input_hash          | text                     |           |          |                                              | extended |             |              | 
 output_json         | jsonb                    |           |          |                                              | extended |             |              | 
 tokens_input        | integer                  |           |          |                                              | plain    |             |              | 
 tokens_output       | integer                  |           |          |                                              | plain    |             |              | 
 cost_usd_microcents | integer                  |           |          |                                              | plain    |             |              | 
 status              | text                     |           | not null |                                              | extended |             |              | 
 error_message       | text                     |           |          |                                              | extended |             |              | 
 started_at          | timestamp with time zone |           | not null | now()                                        | plain    |             |              | 
 finished_at         | timestamp with time zone |           |          |                                              | plain    |             |              | 
Indexes:
    "agent_runs_pkey" PRIMARY KEY, btree (id)
    "agent_runs_by_capture" btree (capture_id)
    "agent_runs_by_entity_jsonb" btree (((output_json ->> 'entity_id'::text)::uuid), started_at DESC) WHERE output_json ? 'entity_id'::text
    "agent_runs_by_owner_started" btree (owner_id, started_at)
Triggers:
    trg_agent_run_notify AFTER INSERT ON agent_runs FOR EACH ROW EXECUTE FUNCTION notify_agent_run()
Access method: heap


## b) agent_runs.agent_name granularity (Open Q1 answer)
                   agent_name                   |  n   
------------------------------------------------+------
 triage                                         | 1641
 voice-capture                                  |   27
 granola-poller                                 |   20
 transcript-extractor                           |   19
 entity-resolver:Damien                         |   16
 transcript-indexed                             |   15
 entity-resolver:Robin                          |    7
 entity-resolver:Tailforge                      |    6
 entity-resolver:Lovable                        |    6
 entity-resolver:Jonas                          |    5
 entity-resolver:Notion                         |    5
 entity-resolver:Almi                           |    5
 entity-resolver:Peter                          |    5
 entity-resolver:Monika                         |    5
 entity-resolver:Science Park                   |    5
 entity-resolver:Simon                          |    5
 entity-resolver:Anton                          |    4
 weekly-review                                  |    4
 entity-resolver:Tom                            |    4
 entity-resolver:Canva                          |    3
 entity-resolver:Emma                           |    3
 day-close                                      |    3
 entity-resolver:Monday                         |    3
 entity-resolver:Javier                         |    3
 entity-resolver:KB                             |    3
 entity-resolver:Linus                          |    3
 entity-resolver:Kevin                          |    3
 morning-brief                                  |    3
 entity-resolver:Sofia                          |    2
 entity-resolver:Google Cloud                   |    2
 entity-resolver:Skolpilot                      |    2
 entity-resolver:Sara Witt                      |    2
 entity-resolver:Emma Burman                    |    2
 entity-resolver:WhatsApp                       |    2
 entity-resolver:Magnus                         |    2
 entity-resolver:Almi Invest                    |    2
 entity-resolver:Adam                           |    2
 entity-resolver:Tailforge Content Hub          |    2
 entity-resolver:TaleForge                      |    2
 entity-resolver:Tomas Varsik                   |    1
 entity-resolver:Västra                         |    1
 entity-resolver:Roblox                         |    1
 entity-resolver:Mindmirror                     |    1
 entity-resolver:UF                             |    1
 entity-resolver:Google Credits                 |    1
 entity-resolver:Almi Science Park              |    1
 entity-resolver:Sentry                         |    1
 entity-resolver:Sofia Nabil                    |    1
 entity-resolver:Silvia                         |    1
 entity-resolver:Patricia                       |    1
 entity-resolver:Google Forms                   |    1
 entity-resolver:Google Workspace               |    1
 entity-resolver:Hirebetter                     |    1
 entity-resolver:Cloud                          |    1
 entity-resolver:Quinten                        |    1
 entity-resolver:Howlingna Energy               |    1
 entity-resolver:mitt team                      |    1
 entity-resolver:GPT                            |    1
 entity-resolver:Grundskoleutmaningen           |    1
 entity-resolver:Superbase                      |    1
 entity-resolver:Storybird                      |    1
 entity-resolver:IONOS                          |    1
 entity-resolver:Emma Näs                       |    1
 entity-resolver:Susanne                        |    1
 entity-resolver:Giant                          |    1
 entity-resolver:BMC                            |    1
 entity-resolver:Camille                        |    1
 entity-resolver:Claude Cowork                  |    1
 entity-resolver:Speed                          |    1
 entity-resolver:Vinnova                        |    1
 entity-resolver:Internship-annons              |    1
 entity-resolver:Kian                           |    1
 entity-resolver:Julius                         |    1
 entity-resolver:Google Image 2.5 Flash         |    1
 entity-resolver:GAU Consulting                 |    1
 entity-resolver:11 Labs                        |    1
 entity-resolver:Jonathan Schauman              |    1
 entity-resolver:Azure                          |    1
 entity-resolver:Cursor                         |    1
 entity-resolver:Monica                         |    1
 entity-resolver:Freelance Software/AI Engineer |    1
 entity-resolver:DataDog                        |    1
 entity-resolver:Nazeem                         |    1
 entity-resolver:Jerry                          |    1
 entity-resolver:Loveable                       |    1
 entity-resolver:EIC Accelerator                |    1
 entity-resolver:Microsoft Azure                |    1
 entity-resolver:LinkedIn                       |    1
 entity-resolver:Cassel-ramverket               |    1
 entity-resolver:Marcus                         |    1
 entity-resolver:GAU Ventures                   |    1
 entity-resolver:Christina                      |    1
 entity-resolver:Claude Sonnet 4.7              |    1
 entity-resolver:Joanna                         |    1
 entity-resolver:Storytel                       |    1
 entity-resolver:Khan Academy Kids              |    1
 entity-resolver:min fru                        |    1
 entity-resolver:Twilio                         |    1
 entity-resolver:Sarah                          |    1
 entity-resolver:PostHog                        |    1
 entity-resolver:Hive and Five                  |    1
 entity-resolver:Outbehaving                    |    1
 entity-resolver:Kristina                       |    1
 entity-resolver:Innovativa Startups            |    1
 entity-resolver:Tale Forge                     |    1
 entity-resolver:Jesper                         |    1
 entity-resolver:Abel                           |    1
(107 rows)


## c) capture-table search (Open Q2 — capture_text / capture_voice DO NOT EXIST)
      table_name      
----------------------
 event_log
 inbox_index
 mention_events
 telegram_inbox_queue
(4 rows)


## d) event_log schema (likely captures source-of-truth)
                                                                                                             Table "public.event_log"
   Column    |           Type           | Collation | Nullable |                   Default                    | Storage  | Compression | Stats target |                                        Description                                         
-------------+--------------------------+-----------+----------+----------------------------------------------+----------+-------------+--------------+--------------------------------------------------------------------------------------------
 id          | uuid                     |           | not null | gen_random_uuid()                            | plain    |             |              | 
 owner_id    | uuid                     |           | not null | '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid | plain    |             |              | 
 kind        | text                     |           | not null |                                              | extended |             |              | See packages/contracts/src/migration.ts EventLogKindSchema for the allowed Phase-10 kinds.
 detail      | jsonb                    |           |          |                                              | extended |             |              | 
 occurred_at | timestamp with time zone |           | not null | now()                                        | plain    |             |              | 
 actor       | text                     |           | not null |                                              | extended |             |              | Plan id (e.g. 'plan-10-03') or operator handle that wrote the row.
Indexes:
    "event_log_pkey" PRIMARY KEY, btree (id)
    "event_log_by_kind" btree (kind, occurred_at)
    "event_log_owner_at_idx" btree (owner_id, occurred_at DESC)
Access method: heap


## e) event_log.detail_type distinct values (last 7 days)
psql:/tmp/phase11-schema-queries.sql:22: ERROR:  column "detail_type" does not exist
LINE 1: SELECT detail_type, COUNT(*) AS n FROM event_log WHERE creat...
               ^

## f) mention_events schema
                                                                   Table "public.mention_events"
   Column    |           Type           | Collation | Nullable |                   Default                    | Storage  | Compression | Stats target | Description 
-------------+--------------------------+-----------+----------+----------------------------------------------+----------+-------------+--------------+-------------
 id          | uuid                     |           | not null | gen_random_uuid()                            | plain    |             |              | 
 owner_id    | uuid                     |           | not null | '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid | plain    |             |              | 
 entity_id   | uuid                     |           |          |                                              | plain    |             |              | 
 capture_id  | text                     |           |          |                                              | extended |             |              | 
 source      | text                     |           | not null |                                              | extended |             |              | 
 context     | text                     |           |          |                                              | extended |             |              | 
 occurred_at | timestamp with time zone |           | not null |                                              | plain    |             |              | 
 created_at  | timestamp with time zone |           | not null | now()                                        | plain    |             |              | 
Indexes:
    "mention_events_pkey" PRIMARY KEY, btree (id)
    "mention_events_by_entity_time" btree (entity_id, occurred_at)
    "mention_events_by_entity_time_desc" btree (entity_id, occurred_at DESC, id DESC) WHERE owner_id IS NOT NULL
Foreign-key constraints:
    "mention_events_entity_id_fkey" FOREIGN KEY (entity_id) REFERENCES entity_index(id)
Triggers:
    trg_entity_dossiers_cached_invalidate AFTER INSERT ON mention_events FOR EACH ROW EXECUTE FUNCTION invalidate_dossier_cache_on_mention()
    trg_mark_top3_acted_on AFTER INSERT ON mention_events FOR EACH ROW EXECUTE FUNCTION mark_top3_acted_on()
    trg_mention_notify AFTER INSERT ON mention_events FOR EACH ROW EXECUTE FUNCTION notify_timeline_event()
Access method: heap


## g) mention_events.source distinct values
       source       
--------------------
 granola-transcript
 telegram-voice
 dashboard-text
(3 rows)


## h) telegram_inbox_queue schema
                                                                Table "public.telegram_inbox_queue"
   Column    |           Type           | Collation | Nullable |                   Default                    | Storage  | Compression | Stats target | Description 
-------------+--------------------------+-----------+----------+----------------------------------------------+----------+-------------+--------------+-------------
 id          | uuid                     |           | not null | gen_random_uuid()                            | plain    |             |              | 
 owner_id    | uuid                     |           | not null | '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid | plain    |             |              | 
 body        | text                     |           | not null |                                              | extended |             |              | 
 reason      | text                     |           | not null |                                              | extended |             |              | 
 queued_at   | timestamp with time zone |           | not null | now()                                        | plain    |             |              | 
 released_at | timestamp with time zone |           |          |                                              | plain    |             |              | 
Indexes:
    "telegram_inbox_queue_pkey" PRIMARY KEY, btree (id)
Access method: heap


## i) calendar_events_cache schema
                                                        Table "public.calendar_events_cache"
      Column      |           Type           | Collation | Nullable |         Default          | Storage  | Compression | Stats target | Description 
------------------+--------------------------+-----------+----------+--------------------------+----------+-------------+--------------+-------------
 event_id         | text                     |           | not null |                          | extended |             |              | 
 account          | text                     |           | not null |                          | extended |             |              | 
 owner_id         | uuid                     |           | not null |                          | plain    |             |              | 
 calendar_id      | text                     |           | not null |                          | extended |             |              | 
 summary          | text                     |           | not null |                          | extended |             |              | 
 description      | text                     |           |          |                          | extended |             |              | 
 location         | text                     |           |          |                          | extended |             |              | 
 start_utc        | timestamp with time zone |           | not null |                          | plain    |             |              | 
 end_utc          | timestamp with time zone |           | not null |                          | plain    |             |              | 
 timezone         | text                     |           | not null | 'Europe/Stockholm'::text | extended |             |              | 
 attendees_json   | jsonb                    |           | not null | '[]'::jsonb              | extended |             |              | 
 is_all_day       | boolean                  |           | not null | false                    | plain    |             |              | 
 ignored_by_kevin | boolean                  |           | not null | false                    | plain    |             |              | 
 updated_at       | timestamp with time zone |           | not null |                          | plain    |             |              | 
 cached_at        | timestamp with time zone |           | not null | now()                    | plain    |             |              | 
Indexes:
    "calendar_events_cache_pkey" PRIMARY KEY, btree (event_id, account)
    "calendar_events_cache_account_updated_idx" btree (account, updated_at DESC)
    "calendar_events_cache_owner_window_idx" btree (owner_id, start_utc) WHERE ignored_by_kevin = false
Check constraints:
    "calendar_events_cache_account_check" CHECK (account = ANY (ARRAY['kevin-elzarka'::text, 'kevin-taleforge'::text]))
Access method: heap


## j) inbox_index schema
                                                                          Table "public.inbox_index"
        Column         |           Type           | Collation | Nullable |                   Default                    | Storage  | Compression | Stats target | Description 
-----------------------+--------------------------+-----------+----------+----------------------------------------------+----------+-------------+--------------+-------------
 id                    | text                     |           | not null |                                              | extended |             |              | 
 owner_id              | uuid                     |           | not null | '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid | plain    |             |              | 
 kind                  | text                     |           | not null |                                              | extended |             |              | 
 title                 | text                     |           | not null |                                              | extended |             |              | 
 preview               | text                     |           | not null |                                              | extended |             |              | 
 bolag                 | text                     |           |          |                                              | extended |             |              | 
 entity_id             | uuid                     |           |          |                                              | plain    |             |              | 
 merge_id              | text                     |           |          |                                              | extended |             |              | 
 payload               | jsonb                    |           | not null | '{}'::jsonb                                  | extended |             |              | 
 status                | text                     |           | not null | 'pending'::text                              | extended |             |              | 
 notion_last_edited_at | timestamp with time zone |           |          |                                              | plain    |             |              | 
 created_at            | timestamp with time zone |           | not null | now()                                        | plain    |             |              | 
 updated_at            | timestamp with time zone |           | not null | now()                                        | plain    |             |              | 
Indexes:
    "inbox_index_pkey" PRIMARY KEY, btree (id)
    "inbox_index_by_entity" btree (entity_id) WHERE entity_id IS NOT NULL
    "inbox_index_by_merge" btree (merge_id) WHERE merge_id IS NOT NULL
    "inbox_index_pending" btree (owner_id, created_at DESC) WHERE status = 'pending'::text
Check constraints:
    "inbox_index_bolag_check" CHECK (bolag IS NULL OR (bolag = ANY (ARRAY['tale-forge'::text, 'outbehaving'::text, 'personal'::text])))
    "inbox_index_kind_check" CHECK (kind = ANY (ARRAY['draft_reply'::text, 'entity_routing'::text, 'new_entity'::text, 'merge_resume'::text]))
    "inbox_index_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text, 'skipped'::text, 'rejected'::text, 'archived'::text]))
Foreign-key constraints:
    "inbox_index_entity_id_fkey" FOREIGN KEY (entity_id) REFERENCES entity_index(id)
    "inbox_index_merge_id_fkey" FOREIGN KEY (merge_id) REFERENCES entity_merge_audit(merge_id)
Triggers:
    trg_inbox_notify AFTER INSERT ON inbox_index FOR EACH ROW EXECUTE FUNCTION notify_inbox_item()
Access method: heap


## k) inbox_index.kind distinct values
      kind      | n 
----------------+---
 new_entity     | 5
 draft_reply    | 2
 entity_routing | 2
 merge_resume   | 1
(4 rows)


## l) email_drafts schema
                                                         Table "public.email_drafts"
     Column      |           Type           | Collation | Nullable |      Default      | Storage  | Compression | Stats target | Description 
-----------------+--------------------------+-----------+----------+-------------------+----------+-------------+--------------+-------------
 id              | uuid                     |           | not null | gen_random_uuid() | plain    |             |              | 
 owner_id        | uuid                     |           | not null |                   | plain    |             |              | 
 capture_id      | text                     |           | not null |                   | extended |             |              | 
 account_id      | text                     |           | not null |                   | extended |             |              | 
 message_id      | text                     |           | not null |                   | extended |             |              | 
 from_email      | text                     |           | not null |                   | extended |             |              | 
 to_email        | text[]                   |           | not null | '{}'::text[]      | extended |             |              | 
 subject         | text                     |           |          |                   | extended |             |              | 
 classification  | text                     |           | not null |                   | extended |             |              | 
 draft_body      | text                     |           |          |                   | extended |             |              | 
 draft_subject   | text                     |           |          |                   | extended |             |              | 
 status          | text                     |           | not null | 'draft'::text     | extended |             |              | 
 received_at     | timestamp with time zone |           | not null |                   | plain    |             |              | 
 triaged_at      | timestamp with time zone |           |          |                   | plain    |             |              | 
 approved_at     | timestamp with time zone |           |          |                   | plain    |             |              | 
 sent_at         | timestamp with time zone |           |          |                   | plain    |             |              | 
 sent_message_id | text                     |           |          |                   | extended |             |              | 
Indexes:
    "email_drafts_pkey" PRIMARY KEY, btree (id)
    "email_drafts_account_message_uidx" UNIQUE CONSTRAINT, btree (account_id, message_id)
    "email_drafts_owner_classification_idx" btree (owner_id, classification, received_at DESC)
    "email_drafts_owner_status_idx" btree (owner_id, status, received_at DESC)
Check constraints:
    "email_drafts_classification_check" CHECK (classification = ANY (ARRAY['urgent'::text, 'important'::text, 'informational'::text, 'junk'::text, 'pending_triage'::text]))
    "email_drafts_status_check" CHECK (status = ANY (ARRAY['pending_triage'::text, 'draft'::text, 'edited'::text, 'approved'::text, 'skipped'::text, 'sent'::text, 'failed'::text]))
Referenced by:
    TABLE "email_send_authorizations" CONSTRAINT "email_send_authorizations_draft_id_fkey" FOREIGN KEY (draft_id) REFERENCES email_drafts(id) ON DELETE CASCADE
Access method: heap


## m) email_drafts.classification x status crosstab
 classification | status  | n 
----------------+---------+---
 informational  | skipped | 1
 junk           | skipped | 1
(2 rows)


## n) agent_dead_letter schema
                                                      Table "public.agent_dead_letter"
     Column      |           Type           | Collation | Nullable |      Default      | Storage  | Compression | Stats target | Description 
-----------------+--------------------------+-----------+----------+-------------------+----------+-------------+--------------+-------------
 id              | uuid                     |           | not null | gen_random_uuid() | plain    |             |              | 
 owner_id        | uuid                     |           | not null |                   | plain    |             |              | 
 capture_id      | text                     |           | not null |                   | extended |             |              | 
 agent_run_id    | uuid                     |           |          |                   | plain    |             |              | 
 tool_name       | text                     |           | not null |                   | extended |             |              | 
 error_class     | text                     |           | not null |                   | extended |             |              | 
 error_message   | text                     |           | not null |                   | extended |             |              | 
 request_preview | text                     |           |          |                   | extended |             |              | 
 occurred_at     | timestamp with time zone |           | not null | now()             | plain    |             |              | 
 retried_at      | timestamp with time zone |           |          |                   | plain    |             |              | 
Indexes:
    "agent_dead_letter_pkey" PRIMARY KEY, btree (id)
    "agent_dead_letter_owner_occurred_idx" btree (owner_id, occurred_at DESC)
Access method: heap


## o) inbox_index demo-name match preview (D-03 wipe targets)
              title               |      kind      | status  | n 
----------------------------------+----------------+---------+---
 Christina Larsson                | new_entity     | pending | 1
 Damien Carter                    | new_entity     | pending | 1
 Lars Svensson                    | new_entity     | pending | 1
 Paused: Maria vs Maria Johansson | merge_resume   | pending | 1
 Possible duplicate: Damien C.    | entity_routing | pending | 1
 Re: Partnership proposal         | draft_reply    | pending | 1
 Re: Summer meeting               | draft_reply    | pending | 1
(7 rows)


## p) email_drafts demo-subject match preview
 subject | draft_subject | classification | status | n 
---------+---------------+----------------+--------+---
(0 rows)

