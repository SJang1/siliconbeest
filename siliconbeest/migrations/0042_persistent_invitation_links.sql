-- Keep invitation tokens recoverable for their owners without storing bearer
-- credentials as plaintext.

ALTER TABLE registration_invites ADD COLUMN token_ciphertext TEXT;
