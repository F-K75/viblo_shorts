# Managed PostgreSQL — Provider Comparison and Recommendation (for approval)

> Status: **proposal; nothing provisioned, no provider locked.** Decision inputs: India users (latency), provisional
> **RPO 15 min / RTO 4 h**, encrypted off-site backups with a separate KMS-managed key, multi-instance app.

## 0. The deciding question: where will the app run?

The repository does **not** define a hosting platform: no Terraform, no platform manifests, only a Dockerfile.
The database should live in the **same cloud and region as the app**. Every query is a network round trip, and the
re-audit measured 3–4 transactions per AI request (R-15). A cross-cloud database adds roughly 2–20 ms per round
trip and egress costs.

**Decision needed from you:** the target hosting platform. My recommendation in §4 assumes the most likely
options for a containerised Node app serving India.

## 1. Evidence quality (read this first)

This session's network allowlist blocks most provider documentation hosts (neon.com, supabase.com,
docs.aws.amazon.com, docs.digitalocean.com, learn.microsoft.com). Each fact below is therefore marked:
* **[S]** confirmed this session via search results (sources at the end);
* **[K]** from prior knowledge, **not re-verified here**: confirm on the provider's page before committing.

Prices are deliberately omitted. They change often and could not be verified here, so get a quote for the target
size (2 vCPU / 8 GB / 50–100 GB to start).

## 2. Requirements the provider must meet

| Requirement | Why | How it maps |
|---|---|---|
| India region (Mumbai/Hyderabad/Delhi/Chennai/Bangalore) | Latency for Indian users; data residency | Same region as the app |
| PITR with WAL archiving, RPO ≤ 5 min | Provisional **RPO 15 min** (needs margin) | Logical dumps alone cannot meet 15 min at scale |
| HA with automatic failover (standby in a 2nd zone) | Instance or zone loss without data loss | RTO in minutes for infra failures |
| Restore to a new instance in ≪ 4 h | Provisional **RTO 4 h** | Must be **measured** with production-sized data |
| Connection pooling (PgBouncer-compatible) | instances × `DATABASE_POOL_MAX` connections | Our code uses no session state outside transactions, so transaction pooling works |
| TLS with certificate verification | ADR-001 | `sslmode=verify-full` + CA bundle |
| Private networking to the app | Keep the DB off the public internet | VPC / private service connect |
| Customer-managed keys (CMK/KMS) for storage | Your decision: KMS-managed keys | Provider KMS integration |
| PostgreSQL ≥ 14 (we test 16) | Features we rely on (`SKIP LOCKED`, jsonb) | All candidates |

## 3. Candidates

| Provider | India regions | PITR | HA | Pooling | Ops complexity | Notes |
|---|---|---|---|---|---|---|
| **AWS RDS for PostgreSQL** | Mumbai `ap-south-1`, Hyderabad `ap-south-2` **[S]** (Hyderabad lags on some features **[S]**) | Yes, retention up to 35 days, latest restorable time typically ≤ 5 min **[K]** | Multi-AZ standby across two AZs **[S]** | RDS Proxy **[K]**, or PgBouncer sidecar | Medium | Most mature; KMS CMK for storage and snapshots **[K]**; cross-region snapshot copy **[K]** |
| **Google Cloud SQL for PostgreSQL** | Mumbai `asia-south1`, Delhi `asia-south2` **[K]**; Enterprise Plus listed for Delhi **[S]** | PITR creates a new instance **[S]**; Enterprise Plus up to 35 days **[S]**, Enterprise shorter (7 days) **[K]** | Regional (two-zone synchronous) HA **[S]**; Enterprise Plus 99.99 % SLA **[S]** | Managed Connection Pooling (newer) **[K]** or PgBouncer | Medium | Natural fit with Cloud Run; CMEK **[K]** |
| **Azure Database for PostgreSQL – Flexible Server** | Central India (Pune), South India (Chennai) **[K]** (per-region HA options **not confirmed [S]**) | Restore to any point in retention; restore creates a new server **[S]** | Zone-redundant warm standby **[S]** (availability per region to confirm) | Built-in PgBouncer on port 6432 **[S]** | Medium | Fit if the app is on Azure (Container Apps / AKS) |
| **Supabase** | Mumbai `ap-south-1` **[K]** (not confirmed **[S]**) | Paid PITR add-on, worst-case RPO ~2 min, seconds granularity **[S]** | Varies by plan **[K]** | Supavisor pooler **[K]** | Low | Bundles auth/storage we don't need; PITR is an add-on |
| **Neon** | No India region known **[K]** (not confirmed either way **[S]**) | Instant restore within a history window (up to 7–30 days by plan) **[S]** | Storage-level redundancy; compute restarts **[K]** | Built-in PgBouncer **[K]** | Low | Serverless scale-to-zero; cold starts; India latency risk if no in-country region |
| **DigitalOcean Managed PostgreSQL** | Bangalore `BLR1` **[K]** (not confirmed **[S]**) | Daily backups + 7 days of WAL for PITR **[S]**; restore creates a new cluster **[S]** | Standby nodes with automatic failover **[S]** | Built-in PgBouncer pools **[K]** | Low | Simplest; 7-day PITR window; fewer enterprise controls (CMK) **[K]** |

## 4. Recommendation

**If you have no strong platform preference: AWS (app on ECS Fargate or App Runner in `ap-south-1`) with
RDS for PostgreSQL Multi-AZ in `ap-south-1`.**
* It meets every requirement in §2 natively: PITR typically ≤ 5 min behind (comfortably inside RPO 15 min), a
  Multi-AZ standby in a second zone, KMS customer-managed keys for storage and snapshots, private VPC networking,
  and RDS Proxy for pooling.
* The off-site backup architecture maps directly onto AWS: an S3 bucket in a **different region** (e.g.
  Hyderabad `ap-south-2` or Singapore) with SSE-KMS, versioning and Object Lock, plus a separate KMS key for
  envelope encryption (§5).
* Mumbai is a primary, feature-complete region. Hyderabad lags on some features **[S]**, which makes it a better
  backup/DR region than a primary.

**If the platform is Google Cloud (Cloud Run):** Cloud SQL Enterprise Plus in `asia-south1` (confirm Enterprise
Plus there; it is confirmed for Delhi **[S]**) with regional HA. The off-site copy goes to GCS in `asia-south2`
with CMEK. **If Azure:** Flexible Server zone-redundant HA in Central India, after confirming zone-redundant HA
there. **If you want the lowest operational effort and accept fewer controls:** DigitalOcean BLR1 or Supabase
Mumbai, once in-country availability and PITR are confirmed; check the CMK gap against your KMS requirement.

**Not recommended as primary:** Neon, unless an in-country India region is confirmed (latency), and anything
cross-cloud from the app.

## 5. Backup architecture with a separate KMS-managed key (your decision; design for approval)

The current implementation (Phase 2) encrypts dumps with **age** using a public key, with the private key kept
offline. Your decision asks for a **KMS-managed** key held separately from the backups. Proposed design (AWS
names; GCP/Azure have direct equivalents):

1. **Envelope encryption per backup:** generate a random 256-bit data key (`kms:GenerateDataKey` on key
   `forge-backup-kek`); stream `pg_dump` through AES-256-GCM with that data key (no plaintext on disk); store
   only the **KMS-wrapped** data key in the manifest; discard the plaintext key.
2. **Separation of duties:** the backup job's role may call `GenerateDataKey` only (it can create backups, never
   read them). Only a break-glass **restore role** may call `kms:Decrypt`; using it raises an alert. The KEK lives
   in KMS, never with the backups, and has rotation and deletion protection enabled.
3. **Storage:** a dedicated bucket in **another region/account**, SSE-KMS with a *different* key, versioning,
   Object Lock (compliance mode) for the retention period, and a write-only credential for the backup job. A
   lifecycle policy enforces retention.
4. **Integrity:** SHA-256 of the ciphertext in the manifest plus GCM authentication tags. Restore verifies both
   (today's verification steps carry over).
5. **Provider PITR stays primary** for RPO; logical off-site dumps are the provider-independent copy (account or
   region loss, ransomware).

This changes `server/db/offsiteBackup.ts` (age → KMS envelope) and needs the provider decision. **It is not
implemented yet; the existing age path keeps working until then.**

## 6. Can RPO 15 min / RTO 4 h be met?

| Scenario | Mechanism | Expected RPO | Expected RTO | Verify by |
|---|---|---|---|---|
| Zone/instance failure | Multi-AZ / regional HA failover | ~0 | minutes | Provider failover test in staging |
| Bad deploy / accidental delete | Provider PITR to a new instance, then switch `DATABASE_URL` | ≤ 5 min **[K]** | 30–90 min for tens of GB (size-dependent) | **Timed PITR drill** on a production-sized copy |
| Region/account loss, ransomware | Off-site KMS-encrypted dump → restore to new instance in DR region | ≤ backup interval: **must be ≤ 15 min**, so schedule every 15 min, or ship WAL off-site | download + restore (size-dependent) | **Timed off-site restore drill** |

**Conclusion:** RPO 15 min is achievable for infrastructure failures and logical errors through provider PITR. For
region or account loss it needs either 15-minute off-site dumps (feasible only while the database is small) or
continuous WAL shipping to the off-site bucket (e.g. pgBackRest or WAL-G, which needs a provider that exposes WAL;
most managed services do not). RTO 4 h is very likely achievable but is **unverified until a timed drill runs
on production-sized data.** I recommend accepting **RPO 15 min for in-region scenarios** and stating a
separate, honest **RPO for full region loss** (e.g. 1 h) unless you approve WAL shipping.

## Sources (searched this session)
- [Neon: backup & restore overview](https://neon.com/docs/manage/backups.md) · [Neon: history window](https://neon.com/docs/postgres/backup-restore/history-window) · [Neon: PITR across providers](https://neon.com/faqs/managed-postgres-providers-point-in-time-recovery)
- [Supabase: database backups](https://supabase.com/docs/guides/platform/backups.md) · [Supabase: backups feature](https://supabase.com/features/database-backups)
- [Google Cloud: Enterprise Plus in new regions](https://cloud.google.com/blog/products/databases/cloud-sql-enterprise-plus-edition-available-in-new-regions) · [Cloud SQL feature support](https://docs.cloud.google.com/sql/docs/feature_support)
- [AWS: RDS regions and AZs](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Concepts.RegionsAndAvailabilityZones.html) · [AWS: PostgreSQL availability (prescriptive guidance)](https://docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-managed-postgresql/availability.html)
- [Azure Database for PostgreSQL overview](https://learn.microsoft.com/en-us/azure/postgresql/overview)
- [DigitalOcean: restore PostgreSQL from backups](https://docs.digitalocean.com/products/databases/postgresql/how-to/restore-from-backups) · [DigitalOcean: PITR glossary](https://docs.digitalocean.com/glossary/pitr)
