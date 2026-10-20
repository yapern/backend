-- DNS resolution previously treated CNAME targets as invalid addresses.
-- Expire those specific negative cache entries so requests retry after the fix.
UPDATE link_previews
SET expires_at = 0
WHERE state = 'failed' AND error = 'preview_dns_not_public';
