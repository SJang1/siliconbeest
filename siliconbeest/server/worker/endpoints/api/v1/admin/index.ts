import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';

import accounts from './accounts/index';
import reports from './reports/index';
import statuses from './statuses/index';
import domainBlocks from './domainBlocks';
import domainAllows from './domainAllows';
import emailDomainBlocks from './emailDomainBlocks';
import ipBlocks from './ipBlocks';
import settings from './settings';
import announcements from './announcements';
import rules from './rules';
import measures from './measures';
import relays from './relays';
import email from './email';
import customEmojis from './customEmojis';
import federation from './federation';

const admin = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// Each sub-router applies authRequired + adminRequired internally
admin.route('/accounts', accounts);
admin.route('/reports', reports);
admin.route('/statuses', statuses);
admin.route('/domain_blocks', domainBlocks);
admin.route('/domain_allows', domainAllows);
admin.route('/email_domain_blocks', emailDomainBlocks);
admin.route('/ip_blocks', ipBlocks);
admin.route('/settings', settings);
admin.route('/announcements', announcements);
admin.route('/rules', rules);
admin.route('/measures', measures);
admin.route('/relays', relays);
admin.route('/email', email);
admin.route('/custom_emojis', customEmojis);
admin.route('/federation', federation);

export default admin;
