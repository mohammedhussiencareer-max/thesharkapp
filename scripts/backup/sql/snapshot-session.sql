begin isolation level repeatable read read only;
select pg_export_snapshot() as snap \gset
\setenv BACKUP_SNAPSHOT :snap
\! "$BACKUP_INNER" </dev/null
rollback;
