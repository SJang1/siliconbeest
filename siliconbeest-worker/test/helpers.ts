import { env } from 'cloudflare:test';

export async function applyMigration() {
  await env.DB.prepare('CREATE TABLE accounts ( id TEXT PRIMARY KEY, username TEXT NOT NULL, domain TEXT, display_name TEXT DEFAULT \'\', note TEXT DEFAULT \'\', uri TEXT NOT NULL UNIQUE, url TEXT, avatar_url TEXT DEFAULT \'\', avatar_static_url TEXT DEFAULT \'\', header_url TEXT DEFAULT \'\', header_static_url TEXT DEFAULT \'\', locked INTEGER DEFAULT 0, bot INTEGER DEFAULT 0, discoverable INTEGER DEFAULT 1, manually_approves_followers INTEGER DEFAULT 0, statuses_count INTEGER DEFAULT 0, followers_count INTEGER DEFAULT 0, following_count INTEGER DEFAULT 0, last_status_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, suspended_at TEXT, silenced_at TEXT, memorial INTEGER DEFAULT 0, moved_to_account_id TEXT, UNIQUE(username, domain) )').run();
  await env.DB.prepare('CREATE INDEX idx_accounts_uri ON accounts(uri)').run();
  await env.DB.prepare('CREATE INDEX idx_accounts_domain ON accounts(domain)').run();
  await env.DB.prepare('CREATE INDEX idx_accounts_username_domain ON accounts(username, domain)').run();
  await env.DB.prepare('CREATE TABLE users ( id TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id), email TEXT NOT NULL UNIQUE, encrypted_password TEXT NOT NULL, locale TEXT DEFAULT \'en\', confirmed_at TEXT, confirmation_token TEXT, reset_password_token TEXT, reset_password_sent_at TEXT, otp_secret TEXT, otp_enabled INTEGER DEFAULT 0, otp_backup_codes TEXT, role TEXT DEFAULT \'user\', approved INTEGER DEFAULT 1, disabled INTEGER DEFAULT 0, sign_in_count INTEGER DEFAULT 0, current_sign_in_at TEXT, last_sign_in_at TEXT, current_sign_in_ip TEXT, last_sign_in_ip TEXT, chosen_languages TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL )').run();
  await env.DB.prepare('CREATE INDEX idx_users_email ON users(email)').run();
  await env.DB.prepare('CREATE INDEX idx_users_confirmation_token ON users(confirmation_token)').run();
  await env.DB.prepare('CREATE INDEX idx_users_reset_password_token ON users(reset_password_token)').run();
  await env.DB.prepare('CREATE TABLE actor_keys ( id TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id), public_key TEXT NOT NULL, private_key TEXT NOT NULL, key_id TEXT NOT NULL, created_at TEXT NOT NULL )').run();
  await env.DB.prepare('CREATE TABLE statuses ( id TEXT PRIMARY KEY, uri TEXT NOT NULL UNIQUE, url TEXT, account_id TEXT NOT NULL REFERENCES accounts(id), in_reply_to_id TEXT, in_reply_to_account_id TEXT, reblog_of_id TEXT, text TEXT DEFAULT \'\', content TEXT DEFAULT \'\', content_warning TEXT DEFAULT \'\', visibility TEXT DEFAULT \'public\', sensitive INTEGER DEFAULT 0, language TEXT DEFAULT \'en\', conversation_id TEXT, reply INTEGER DEFAULT 0, replies_count INTEGER DEFAULT 0, reblogs_count INTEGER DEFAULT 0, favourites_count INTEGER DEFAULT 0, local INTEGER DEFAULT 1, federated_at TEXT, edited_at TEXT, deleted_at TEXT, poll_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL )').run();
  await env.DB.prepare('CREATE INDEX idx_statuses_account_id ON statuses(account_id)').run();
  await env.DB.prepare('CREATE INDEX idx_statuses_uri ON statuses(uri)').run();
  await env.DB.prepare('CREATE INDEX idx_statuses_in_reply_to ON statuses(in_reply_to_id)').run();
  await env.DB.prepare('CREATE INDEX idx_statuses_reblog_of ON statuses(reblog_of_id)').run();
  await env.DB.prepare('CREATE INDEX idx_statuses_account_created ON statuses(account_id, created_at DESC)').run();
  await env.DB.prepare('CREATE INDEX idx_statuses_visibility_created ON statuses(visibility, created_at DESC)').run();
  await env.DB.prepare('CREATE INDEX idx_statuses_local_created ON statuses(local, created_at DESC)').run();
  await env.DB.prepare('CREATE INDEX idx_statuses_conversation ON statuses(conversation_id)').run();
  await env.DB.prepare('CREATE TABLE media_attachments ( id TEXT PRIMARY KEY, status_id TEXT, account_id TEXT NOT NULL REFERENCES accounts(id), file_key TEXT NOT NULL, file_content_type TEXT NOT NULL, file_size INTEGER DEFAULT 0, thumbnail_key TEXT, remote_url TEXT, description TEXT DEFAULT \'\', blurhash TEXT, width INTEGER, height INTEGER, type TEXT DEFAULT \'image\', created_at TEXT NOT NULL, updated_at TEXT NOT NULL )').run();
  await env.DB.prepare('CREATE INDEX idx_media_status ON media_attachments(status_id)').run();
  await env.DB.prepare('CREATE INDEX idx_media_account ON media_attachments(account_id)').run();
  await env.DB.prepare('CREATE TABLE polls ( id TEXT PRIMARY KEY, status_id TEXT NOT NULL UNIQUE REFERENCES statuses(id), expires_at TEXT, multiple INTEGER DEFAULT 0, votes_count INTEGER DEFAULT 0, voters_count INTEGER DEFAULT 0, options TEXT NOT NULL, created_at TEXT NOT NULL )').run();
  await env.DB.prepare('CREATE TABLE poll_votes ( id TEXT PRIMARY KEY, poll_id TEXT NOT NULL REFERENCES polls(id), account_id TEXT NOT NULL REFERENCES accounts(id), choice INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(poll_id, account_id, choice) )').run();
  await env.DB.prepare('CREATE TABLE follows ( id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), target_account_id TEXT NOT NULL REFERENCES accounts(id), uri TEXT, show_reblogs INTEGER DEFAULT 1, notify INTEGER DEFAULT 0, languages TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(account_id, target_account_id) )').run();
  await env.DB.prepare('CREATE INDEX idx_follows_target ON follows(target_account_id)').run();
  await env.DB.prepare('CREATE INDEX idx_follows_account ON follows(account_id)').run();
  await env.DB.prepare('CREATE TABLE follow_requests ( id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), target_account_id TEXT NOT NULL REFERENCES accounts(id), uri TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(account_id, target_account_id) )').run();
  await env.DB.prepare('CREATE TABLE favourites ( id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), status_id TEXT NOT NULL REFERENCES statuses(id), uri TEXT, created_at TEXT NOT NULL, UNIQUE(account_id, status_id) )').run();
  await env.DB.prepare('CREATE INDEX idx_favourites_status ON favourites(status_id)').run();
  await env.DB.prepare('CREATE INDEX idx_favourites_account ON favourites(account_id)').run();
  await env.DB.prepare('CREATE TABLE blocks ( id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), target_account_id TEXT NOT NULL REFERENCES accounts(id), uri TEXT, created_at TEXT NOT NULL, UNIQUE(account_id, target_account_id) )').run();
  await env.DB.prepare('CREATE TABLE mutes ( id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), target_account_id TEXT NOT NULL REFERENCES accounts(id), hide_notifications INTEGER DEFAULT 1, expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(account_id, target_account_id) )').run();
  await env.DB.prepare('CREATE TABLE bookmarks ( id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), status_id TEXT NOT NULL REFERENCES statuses(id), created_at TEXT NOT NULL, UNIQUE(account_id, status_id) )').run();
  await env.DB.prepare('CREATE INDEX idx_bookmarks_account ON bookmarks(account_id, created_at DESC)').run();
  await env.DB.prepare('CREATE TABLE notifications ( id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), from_account_id TEXT NOT NULL REFERENCES accounts(id), type TEXT NOT NULL, status_id TEXT, read INTEGER DEFAULT 0, created_at TEXT NOT NULL )').run();
  await env.DB.prepare('CREATE INDEX idx_notifications_account ON notifications(account_id, created_at DESC)').run();
  await env.DB.prepare('CREATE INDEX idx_notifications_account_read ON notifications(account_id, read)').run();
  await env.DB.prepare('CREATE TABLE mentions ( id TEXT PRIMARY KEY, status_id TEXT NOT NULL REFERENCES statuses(id), account_id TEXT NOT NULL REFERENCES accounts(id), silent INTEGER DEFAULT 0, created_at TEXT NOT NULL, UNIQUE(status_id, account_id) )').run();
  await env.DB.prepare('CREATE INDEX idx_mentions_account ON mentions(account_id)').run();
  await env.DB.prepare('CREATE TABLE tags ( id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, display_name TEXT, usable INTEGER DEFAULT 1, trendable INTEGER DEFAULT 1, listable INTEGER DEFAULT 1, last_status_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL )').run();
  await env.DB.prepare('CREATE TABLE status_tags ( status_id TEXT NOT NULL REFERENCES statuses(id), tag_id TEXT NOT NULL REFERENCES tags(id), PRIMARY KEY (status_id, tag_id) )').run();
  await env.DB.prepare('CREATE INDEX idx_status_tags_tag ON status_tags(tag_id)').run();
  await env.DB.prepare('CREATE TABLE tag_follows ( id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), tag_id TEXT NOT NULL REFERENCES tags(id), created_at TEXT NOT NULL, UNIQUE(account_id, tag_id) )').run();
  await env.DB.prepare('CREATE TABLE oauth_applications ( id TEXT PRIMARY KEY, name TEXT NOT NULL, website TEXT, redirect_uri TEXT NOT NULL, client_id TEXT NOT NULL UNIQUE, client_secret TEXT NOT NULL, scopes TEXT DEFAULT \'read\', created_at TEXT NOT NULL, updated_at TEXT NOT NULL )').run();
  await env.DB.prepare('CREATE INDEX idx_oauth_apps_client_id ON oauth_applications(client_id)').run();
  await env.DB.prepare('CREATE TABLE oauth_access_tokens ( id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, refresh_token TEXT UNIQUE, application_id TEXT NOT NULL REFERENCES oauth_applications(id), user_id TEXT REFERENCES users(id), scopes TEXT NOT NULL, expires_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL )').run();
  await env.DB.prepare('CREATE INDEX idx_oauth_tokens_token ON oauth_access_tokens(token)').run();
  await env.DB.prepare('CREATE INDEX idx_oauth_tokens_user ON oauth_access_tokens(user_id)').run();
  await env.DB.prepare('CREATE TABLE oauth_authorization_codes ( id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, application_id TEXT NOT NULL REFERENCES oauth_applications(id), user_id TEXT NOT NULL REFERENCES users(id), redirect_uri TEXT NOT NULL, scopes TEXT NOT NULL, code_challenge TEXT, code_challenge_method TEXT, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL )').run();
  await env.DB.prepare('CREATE INDEX idx_oauth_codes_code ON oauth_authorization_codes(code)').run();
  await env.DB.prepare('CREATE TABLE lists ( id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), title TEXT NOT NULL, replies_policy TEXT DEFAULT \'list\', exclusive INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL )').run();
  await env.DB.prepare('CREATE INDEX idx_lists_account ON lists(account_id)').run();
  await env.DB.prepare('CREATE TABLE list_accounts ( list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE, account_id TEXT NOT NULL REFERENCES accounts(id), follow_id TEXT, PRIMARY KEY (list_id, account_id) )').run();
  await env.DB.prepare('CREATE TABLE instances ( id TEXT PRIMARY KEY, domain TEXT NOT NULL UNIQUE, software_name TEXT, software_version TEXT, title TEXT, description TEXT, inbox_url TEXT, public_key TEXT, last_successful_at TEXT, last_failed_at TEXT, failure_count INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL )').run();
  await env.DB.prepare('CREATE INDEX idx_instances_domain ON instances(domain)').run();
  await env.DB.prepare('CREATE TABLE domain_blocks ( id TEXT PRIMARY KEY, domain TEXT NOT NULL UNIQUE, severity TEXT DEFAULT \'silence\', reject_media INTEGER DEFAULT 0, reject_reports INTEGER DEFAULT 0, private_comment TEXT, public_comment TEXT, obfuscate INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL )').run();
  await env.DB.prepare('CREATE TABLE domain_allows ( id TEXT PRIMARY KEY, domain TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL )').run();
  await env.DB.prepare('CREATE TABLE web_push_subscriptions ( id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), access_token_id TEXT NOT NULL REFERENCES oauth_access_tokens(id), endpoint TEXT NOT NULL, key_p256dh TEXT NOT NULL, key_auth TEXT NOT NULL, alert_mention INTEGER DEFAULT 1, alert_follow INTEGER DEFAULT 1, alert_favourite INTEGER DEFAULT 1, alert_reblog INTEGER DEFAULT 1, alert_poll INTEGER DEFAULT 1, alert_status INTEGER DEFAULT 1, alert_update INTEGER DEFAULT 1, alert_follow_request INTEGER DEFAULT 1, alert_admin_sign_up INTEGER DEFAULT 0, alert_admin_report INTEGER DEFAULT 0, policy TEXT DEFAULT \'all\', created_at TEXT NOT NULL, updated_at TEXT NOT NULL )').run();
  await env.DB.prepare('CREATE INDEX idx_push_subs_user ON web_push_subscriptions(user_id)').run();
  await env.DB.prepare('CREATE INDEX idx_push_subs_token ON web_push_subscriptions(access_token_id)').run();
  await env.DB.prepare('CREATE TABLE reports ( id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), target_account_id TEXT NOT NULL REFERENCES accounts(id), status_ids TEXT, comment TEXT DEFAULT \'\', category TEXT DEFAULT \'other\', action_taken INTEGER DEFAULT 0, action_taken_at TEXT, action_taken_by_account_id TEXT, forwarded INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL )').run();
  await env.DB.prepare('CREATE INDEX idx_reports_target ON reports(target_account_id)').run();
  await env.DB.prepare('CREATE TABLE account_warnings ( id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), target_account_id TEXT NOT NULL REFERENCES accounts(id), action TEXT NOT NULL, text TEXT DEFAULT \'\', report_id TEXT, created_at TEXT NOT NULL )').run();
  await env.DB.prepare('CREATE TABLE ip_blocks ( id TEXT PRIMARY KEY, ip TEXT NOT NULL, severity TEXT DEFAULT \'no_access\', comment TEXT DEFAULT \'\', expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL )').run();
  await env.DB.prepare('CREATE TABLE email_domain_blocks ( id TEXT PRIMARY KEY, domain TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL )').run();
  await env.DB.prepare('CREATE TABLE home_timeline_entries ( id TEXT PRIMARY KEY, account_id TEXT NOT NULL, status_id TEXT NOT NULL REFERENCES statuses(id), created_at TEXT NOT NULL, UNIQUE(account_id, status_id) )').run();
  await env.DB.prepare('CREATE INDEX idx_home_timeline ON home_timeline_entries(account_id, created_at DESC)').run();
  await env.DB.prepare('CREATE TABLE markers ( id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), timeline TEXT NOT NULL, last_read_id TEXT NOT NULL, version INTEGER DEFAULT 0, updated_at TEXT NOT NULL, UNIQUE(user_id, timeline) )').run();
  await env.DB.prepare('CREATE TABLE user_preferences ( id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), key TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(user_id, key) )').run();
  await env.DB.prepare('CREATE TABLE filters ( id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, context TEXT NOT NULL, action TEXT DEFAULT \'warn\', expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL )').run();
  await env.DB.prepare('CREATE INDEX idx_filters_user ON filters(user_id)').run();
  await env.DB.prepare('CREATE TABLE filter_keywords ( id TEXT PRIMARY KEY, filter_id TEXT NOT NULL REFERENCES filters(id) ON DELETE CASCADE, keyword TEXT NOT NULL, whole_word INTEGER DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL )').run();
  await env.DB.prepare('CREATE TABLE filter_statuses ( id TEXT PRIMARY KEY, filter_id TEXT NOT NULL REFERENCES filters(id) ON DELETE CASCADE, status_id TEXT NOT NULL REFERENCES statuses(id), created_at TEXT NOT NULL )').run();
  await env.DB.prepare('CREATE TABLE settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL )').run();
  await env.DB.prepare('INSERT INTO settings (key, value, updated_at) VALUES (\'registration_mode\', \'open\', datetime(\'now\')), (\'site_title\', \'SiliconBeest\', datetime(\'now\')), (\'site_description\', \'\', datetime(\'now\')), (\'site_contact_email\', \'\', datetime(\'now\')), (\'site_contact_username\', \'\', datetime(\'now\')), (\'max_toot_chars\', \'500\', datetime(\'now\')), (\'max_media_attachments\', \'4\', datetime(\'now\')), (\'max_poll_options\', \'4\', datetime(\'now\')), (\'poll_max_characters_per_option\', \'50\', datetime(\'now\')), (\'media_max_image_size\', \'16777216\', datetime(\'now\')), (\'media_max_video_size\', \'104857600\', datetime(\'now\')), (\'thumbnail_enabled\', \'1\', datetime(\'now\')), (\'trends_enabled\', \'1\', datetime(\'now\')), (\'require_invite\', \'0\', datetime(\'now\')), (\'min_password_length\', \'8\', datetime(\'now\'))').run();
  await env.DB.prepare('CREATE TABLE custom_emojis ( id TEXT PRIMARY KEY, shortcode TEXT NOT NULL, domain TEXT, image_key TEXT NOT NULL, visible_in_picker INTEGER DEFAULT 1, category TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(shortcode, domain) )').run();
  await env.DB.prepare('CREATE TABLE announcements ( id TEXT PRIMARY KEY, text TEXT NOT NULL, published INTEGER DEFAULT 0, starts_at TEXT, ends_at TEXT, all_day INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL )').run();
  await env.DB.prepare('CREATE TABLE rules ( id TEXT PRIMARY KEY, text TEXT NOT NULL, priority INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL )').run();
  await env.DB.prepare('CREATE TABLE conversations ( id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL )').run();
  await env.DB.prepare('CREATE TABLE conversation_accounts ( conversation_id TEXT NOT NULL REFERENCES conversations(id), account_id TEXT NOT NULL REFERENCES accounts(id), last_status_id TEXT, unread INTEGER DEFAULT 0, PRIMARY KEY (conversation_id, account_id) )').run();
  await env.DB.prepare('CREATE INDEX idx_conv_accounts ON conversation_accounts(account_id)').run();
  await env.DB.prepare('CREATE TABLE relays ( id TEXT PRIMARY KEY, inbox_url TEXT NOT NULL UNIQUE, actor_uri TEXT, state TEXT DEFAULT \'idle\', follow_activity_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL )').run();
}

export async function createTestUser(username: string, opts?: { email?: string; role?: string }) {
  const id = crypto.randomUUID();
  const email = opts?.email || username + '@test.local';
  const role = opts?.role || 'user';
  const now = new Date().toISOString();
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const uri = 'https://test.siliconbeest.local/users/' + username;
  const appId = crypto.randomUUID();
  const clientId = crypto.randomUUID().replace(/-/g, '');
  const clientSecret = crypto.randomUUID().replace(/-/g, '');

  await env.DB.batch([
    env.DB.prepare("INSERT INTO accounts (id, username, domain, display_name, note, uri, url, created_at, updated_at) VALUES (?, ?, NULL, ?, '', ?, ?, ?, ?)").bind(id, username, username, uri, 'https://test.siliconbeest.local/@' + username, now, now),
    env.DB.prepare("INSERT INTO users (id, account_id, email, encrypted_password, role, approved, confirmed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)").bind(id, id, email, 'dummy_hash', role, now, now, now),
    env.DB.prepare("INSERT INTO actor_keys (id, account_id, public_key, private_key, key_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), id, 'test-pub-key', 'test-priv-key', uri + '#main-key', now),
    env.DB.prepare("INSERT INTO oauth_applications (id, name, website, redirect_uri, client_id, client_secret, scopes, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)").bind(appId, 'Test App', 'urn:ietf:wg:oauth:2.0:oob', clientId, clientSecret, 'read write follow push', now, now),
    env.DB.prepare("INSERT INTO oauth_access_tokens (id, token, application_id, user_id, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), token, appId, id, 'read write follow push', now),
  ]);

  return { accountId: id, userId: id, token };
}

export function authHeaders(token: string): Record<string, string> {
  return { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
}
