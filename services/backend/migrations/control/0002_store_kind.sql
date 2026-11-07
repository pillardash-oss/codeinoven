-- A hosted store was once named by its engine. The API contract names the kind
-- instead, because a store can later be the user's own Postgres, so rows written
-- before that change are normalised here rather than leaking "postgres" to a
-- client that types the field as hosted or self_hosted.
UPDATE stores SET kind = 'hosted' WHERE kind = 'postgres';
