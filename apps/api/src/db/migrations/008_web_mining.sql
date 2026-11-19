-- Mining in a browser: phone browsers, computers and Apple devices
-- use the web version of the app. A browser cannot prove what device it runs on, so a "web" device
-- passes a human check where a phone passes a hardware check: once to register, and again at every
-- session (see modules/mining.ts).
ALTER TABLE devices DROP CONSTRAINT devices_platform_check;
ALTER TABLE devices ADD CONSTRAINT devices_platform_check CHECK (platform IN ('ios', 'android', 'web'));

-- Which client started a sign-in. The callback returns the browser to that client's own address
-- (APP_AUTH_REDIRECT or WEB_AUTH_REDIRECT), and the ticket opens a session only for that client.
ALTER TABLE x_logins ADD COLUMN client TEXT NOT NULL DEFAULT 'app' CHECK (client IN ('app', 'web'));
