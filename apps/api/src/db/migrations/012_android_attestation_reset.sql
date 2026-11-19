-- Android phones send key attestation tokens ("akey:" and a certificate chain). Their shape was
-- taken for malformed, so every attempt was counted as a failed device check without the check
-- ever running. Those counts, and the day-long locks they led to, are taken back. iOS and browser
-- rows were not affected and stay as they are.

-- A hold raised from such a count (the account mined in a browser while its phone's count grew) is
-- closed first, while the counts still show which accounts those are: the phone's count is at least
-- the one the flag recorded, and no other device of the account has failures of its own.
UPDATE flags SET status = 'cleared', resolved_by = 'system', resolved_at = EXTRACT(EPOCH FROM now())::BIGINT
WHERE kind = 'attestation_failures' AND status = 'open'
  AND EXISTS (
    SELECT 1 FROM devices d
    WHERE d.user_id = flags.user_id AND d.platform = 'android' AND d.attestation_failures >= (flags.detail->>'failures')::INT
  )
  AND NOT EXISTS (
    SELECT 1 FROM devices d
    WHERE d.user_id = flags.user_id AND d.platform <> 'android' AND d.attestation_failures > 0
  );

UPDATE devices SET attestation_failures = 0, attestation_locked_until = 0
WHERE platform = 'android' AND (attestation_failures > 0 OR attestation_locked_until > 0);
