-- The X profile picture seen at the last sign-in, shown as the account's picture in the app.
-- Only an address on X's image host is ever stored (see xAvatar); the constraint keeps it that way.
ALTER TABLE x_logins ADD COLUMN x_avatar TEXT;
ALTER TABLE users ADD COLUMN avatar_url TEXT CHECK (avatar_url ~ '^https://pbs[.]twimg[.]com/profile_images/[0-9]+/[A-Za-z0-9_-]+[.][a-z]+$');
