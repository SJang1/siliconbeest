/**
 * Server-side email translations for multilingual email delivery.
 *
 * Each locale has strings for every email type. Falls back to 'en'
 * for unsupported locales.
 */

export interface AccountWarningStrings {
	subject: string;
	heading: string;
	description: string;
}

export interface EmailStrings {
	confirmation: {
		subject: (title: string) => string;
		heading: (title: string) => string;
		body: string;
		expiry: string;
	};
	passwordReset: {
		subject: string;
		heading: string;
		body: string;
		expiry: string;
	};
	welcome: {
		subject: (title: string) => string;
		heading: (title: string) => string;
		body: string;
	};
	rejection: {
		subject: string;
		heading: string;
		body: (title: string) => string;
	};
	accountWarning: Record<string, AccountWarningStrings>;
	reasonLabel: string;
}

const translations: Record<string, EmailStrings> = {
	en: {
		confirmation: {
			subject: (title) => `Confirm your email - ${title}`,
			heading: (title) => `Confirm your email - ${title}`,
			body: 'Click the link below to confirm your email address:',
			expiry: 'This link expires in 24 hours.',
		},
		passwordReset: {
			subject: 'Reset your password',
			heading: 'Password Reset',
			body: 'Click the link below to reset your password:',
			expiry: 'This link expires in 1 hour.',
		},
		welcome: {
			subject: (title) => `Welcome to ${title}!`,
			heading: (title) => `Welcome to ${title}!`,
			body: 'Your account has been approved.',
		},
		rejection: {
			subject: 'Registration update',
			heading: 'Registration Update',
			body: (title) => `Your registration at ${title} was not approved at this time.`,
		},
		accountWarning: {
			warn: {
				subject: 'Account Warning',
				heading: 'Account Warning',
				description: 'An administrator has sent a warning to your account.',
			},
			disable: {
				subject: 'Account Frozen',
				heading: 'Account Frozen',
				description: 'An administrator has frozen your account. Login is restricted.',
			},
			silence: {
				subject: 'Account Limited',
				heading: 'Account Limited',
				description: 'An administrator has limited your account. Your posts will only be visible to your followers.',
			},
			suspend: {
				subject: 'Account Suspended',
				heading: 'Account Suspended',
				description: 'An administrator has suspended your account. You can no longer use this account.',
			},
			sensitive: {
				subject: 'Media Marked Sensitive',
				heading: 'Media Marked Sensitive',
				description: 'An administrator has marked your media as sensitive content.',
			},
			none: {
				subject: 'Account Warning',
				heading: 'Account Warning',
				description: 'An administrator has sent a warning to your account.',
			},
			unsuspend: {
				subject: 'Account Reinstated',
				heading: 'Account Reinstated',
				description: 'Your account suspension has been lifted. You can use your account again.',
			},
			unsilence: {
				subject: 'Account Restriction Lifted',
				heading: 'Account Restriction Lifted',
				description: 'The limitation on your account has been removed. Your posts are now visible to everyone again.',
			},
			enable: {
				subject: 'Account Reactivated',
				heading: 'Account Reactivated',
				description: 'Your account has been reactivated. You can log in again.',
			},
			unsensitize: {
				subject: 'Sensitive Media Flag Removed',
				heading: 'Sensitive Media Flag Removed',
				description: 'The sensitive content flag on your media has been removed.',
			},
		},
		reasonLabel: 'Reason',
	},
	ko: {
		confirmation: {
			subject: (title) => `이메일 인증 - ${title}`,
			heading: (title) => `이메일 인증 - ${title}`,
			body: '아래 링크를 클릭하여 이메일 주소를 인증해 주세요:',
			expiry: '이 링크는 24시간 후에 만료됩니다.',
		},
		passwordReset: {
			subject: '비밀번호 재설정',
			heading: '비밀번호 재설정',
			body: '아래 링크를 클릭하여 비밀번호를 재설정해 주세요:',
			expiry: '이 링크는 1시간 후에 만료됩니다.',
		},
		welcome: {
			subject: (title) => `${title}에 오신 것을 환영합니다!`,
			heading: (title) => `${title}에 오신 것을 환영합니다!`,
			body: '회원님의 계정이 승인되었습니다.',
		},
		rejection: {
			subject: '가입 심사 결과',
			heading: '가입 심사 결과',
			body: (title) => `${title} 가입 신청이 현재 승인되지 않았습니다.`,
		},
		accountWarning: {
			warn: {
				subject: '계정 경고',
				heading: '계정 경고',
				description: '관리자가 회원님의 계정에 경고를 보냈습니다.',
			},
			disable: {
				subject: '계정 동결',
				heading: '계정 동결',
				description: '관리자가 회원님의 계정을 동결했습니다. 로그인이 제한됩니다.',
			},
			silence: {
				subject: '계정 제한',
				heading: '계정 제한',
				description: '관리자가 회원님의 계정을 제한했습니다. 게시물이 팔로워에게만 표시됩니다.',
			},
			suspend: {
				subject: '계정 정지',
				heading: '계정 정지',
				description: '관리자가 회원님의 계정을 정지했습니다. 더 이상 이 계정을 사용할 수 없습니다.',
			},
			sensitive: {
				subject: '미디어 민감 표시',
				heading: '미디어 민감 표시',
				description: '관리자가 회원님의 미디어를 민감한 콘텐츠로 표시했습니다.',
			},
			none: {
				subject: '계정 경고',
				heading: '계정 경고',
				description: '관리자가 회원님의 계정에 경고를 보냈습니다.',
			},
			unsuspend: {
				subject: '계정 정지 해제',
				heading: '계정 정지 해제',
				description: '회원님의 계정 정지가 해제되었습니다. 다시 계정을 사용하실 수 있습니다.',
			},
			unsilence: {
				subject: '계정 제한 해제',
				heading: '계정 제한 해제',
				description: '회원님의 계정 제한이 해제되었습니다. 게시물이 다시 모든 사람에게 표시됩니다.',
			},
			enable: {
				subject: '계정 재활성화',
				heading: '계정 재활성화',
				description: '회원님의 계정이 재활성화되었습니다. 다시 로그인하실 수 있습니다.',
			},
			unsensitize: {
				subject: '미디어 민감 표시 해제',
				heading: '미디어 민감 표시 해제',
				description: '회원님의 미디어에 대한 민감 콘텐츠 표시가 해제되었습니다.',
			},
		},
		reasonLabel: '사유',
	},
	ja: {
		confirmation: {
			subject: (title) => `メール認証 - ${title}`,
			heading: (title) => `メール認証 - ${title}`,
			body: '以下のリンクをクリックして、メールアドレスを認証してください：',
			expiry: 'このリンクは24時間後に期限切れになります。',
		},
		passwordReset: {
			subject: 'パスワードリセット',
			heading: 'パスワードリセット',
			body: '以下のリンクをクリックして、パスワードをリセットしてください：',
			expiry: 'このリンクは1時間後に期限切れになります。',
		},
		welcome: {
			subject: (title) => `${title}へようこそ！`,
			heading: (title) => `${title}へようこそ！`,
			body: 'アカウントが承認されました。',
		},
		rejection: {
			subject: '登録審査結果',
			heading: '登録審査結果',
			body: (title) => `${title}への登録は現在承認されませんでした。`,
		},
		accountWarning: {
			warn: {
				subject: 'アカウント警告',
				heading: 'アカウント警告',
				description: '管理者からアカウントに警告が送信されました。',
			},
			disable: {
				subject: 'アカウント凍結',
				heading: 'アカウント凍結',
				description: '管理者によりアカウントが凍結されました。ログインが制限されます。',
			},
			silence: {
				subject: 'アカウント制限',
				heading: 'アカウント制限',
				description: '管理者によりアカウントが制限されました。投稿はフォロワーにのみ表示されます。',
			},
			suspend: {
				subject: 'アカウント停止',
				heading: 'アカウント停止',
				description: '管理者によりアカウントが停止されました。このアカウントは使用できなくなりました。',
			},
			sensitive: {
				subject: 'メディアのセンシティブ指定',
				heading: 'メディアのセンシティブ指定',
				description: '管理者によりメディアがセンシティブなコンテンツとして指定されました。',
			},
			none: {
				subject: 'アカウント警告',
				heading: 'アカウント警告',
				description: '管理者からアカウントに警告が送信されました。',
			},
			unsuspend: {
				subject: 'アカウント停止解除',
				heading: 'アカウント停止解除',
				description: 'アカウントの停止が解除されました。再びアカウントをご利用いただけます。',
			},
			unsilence: {
				subject: 'アカウント制限解除',
				heading: 'アカウント制限解除',
				description: 'アカウントの制限が解除されました。投稿が再び全員に表示されます。',
			},
			enable: {
				subject: 'アカウント再有効化',
				heading: 'アカウント再有効化',
				description: 'アカウントが再有効化されました。再びログインできます。',
			},
			unsensitize: {
				subject: 'メディアのセンシティブ指定解除',
				heading: 'メディアのセンシティブ指定解除',
				description: 'メディアのセンシティブコンテンツ指定が解除されました。',
			},
		},
		reasonLabel: '理由',
	},
	'zh-CN': {
		confirmation: {
			subject: (title) => `验证您的邮箱 - ${title}`,
			heading: (title) => `验证您的邮箱 - ${title}`,
			body: '请点击以下链接验证您的邮箱地址：',
			expiry: '此链接将在24小时后过期。',
		},
		passwordReset: {
			subject: '重置密码',
			heading: '重置密码',
			body: '请点击以下链接重置您的密码：',
			expiry: '此链接将在1小时后过期。',
		},
		welcome: {
			subject: (title) => `欢迎加入 ${title}！`,
			heading: (title) => `欢迎加入 ${title}！`,
			body: '您的账号已被批准。',
		},
		rejection: {
			subject: '注册审核结果',
			heading: '注册审核结果',
			body: (title) => `您在 ${title} 的注册申请暂未通过审核。`,
		},
		accountWarning: {
			warn: {
				subject: '账号警告',
				heading: '账号警告',
				description: '管理员向您的账号发送了一条警告。',
			},
			disable: {
				subject: '账号已冻结',
				heading: '账号已冻结',
				description: '管理员已冻结您的账号，登录将受到限制。',
			},
			silence: {
				subject: '账号已限制',
				heading: '账号已限制',
				description: '管理员已限制您的账号，您的帖子仅对关注者可见。',
			},
			suspend: {
				subject: '账号已停用',
				heading: '账号已停用',
				description: '管理员已停用您的账号，您将无法再使用此账号。',
			},
			sensitive: {
				subject: '媒体已标记为敏感内容',
				heading: '媒体已标记为敏感内容',
				description: '管理员已将您的媒体标记为敏感内容。',
			},
			none: {
				subject: '账号警告',
				heading: '账号警告',
				description: '管理员向您的账号发送了一条警告。',
			},
			unsuspend: {
				subject: '账号已恢复',
				heading: '账号已恢复',
				description: '您的账号封禁已被解除，您可以重新使用账号。',
			},
			unsilence: {
				subject: '账号限制已解除',
				heading: '账号限制已解除',
				description: '您的账号限制已被解除，帖子将重新对所有人可见。',
			},
			enable: {
				subject: '账号已重新激活',
				heading: '账号已重新激活',
				description: '您的账号已重新激活，您可以重新登录。',
			},
			unsensitize: {
				subject: '敏感媒体标记已移除',
				heading: '敏感媒体标记已移除',
				description: '您的媒体的敏感内容标记已被移除。',
			},
		},
		reasonLabel: '原因',
	},
	'zh-TW': {
		confirmation: {
			subject: (title) => `驗證您的電子郵件 - ${title}`,
			heading: (title) => `驗證您的電子郵件 - ${title}`,
			body: '請點擊以下連結驗證您的電子郵件地址：',
			expiry: '此連結將在24小時後失效。',
		},
		passwordReset: {
			subject: '重設密碼',
			heading: '重設密碼',
			body: '請點擊以下連結重設您的密碼：',
			expiry: '此連結將在1小時後失效。',
		},
		welcome: {
			subject: (title) => `歡迎加入 ${title}！`,
			heading: (title) => `歡迎加入 ${title}！`,
			body: '您的帳號已通過審核。',
		},
		rejection: {
			subject: '註冊審核結果',
			heading: '註冊審核結果',
			body: (title) => `您在 ${title} 的註冊申請目前未獲通過。`,
		},
		accountWarning: {
			warn: {
				subject: '帳號警告',
				heading: '帳號警告',
				description: '管理員向您的帳號發送了一則警告。',
			},
			disable: {
				subject: '帳號已凍結',
				heading: '帳號已凍結',
				description: '管理員已凍結您的帳號，登入將受到限制。',
			},
			silence: {
				subject: '帳號已限制',
				heading: '帳號已限制',
				description: '管理員已限制您的帳號，您的貼文僅對追蹤者可見。',
			},
			suspend: {
				subject: '帳號已停權',
				heading: '帳號已停權',
				description: '管理員已停權您的帳號，您將無法再使用此帳號。',
			},
			sensitive: {
				subject: '媒體已標記為敏感內容',
				heading: '媒體已標記為敏感內容',
				description: '管理員已將您的媒體標記為敏感內容。',
			},
			none: {
				subject: '帳號警告',
				heading: '帳號警告',
				description: '管理員向您的帳號發送了一則警告。',
			},
			unsuspend: {
				subject: '帳號已恢復',
				heading: '帳號已恢復',
				description: '您的帳號停權已被解除，您可以重新使用帳號。',
			},
			unsilence: {
				subject: '帳號限制已解除',
				heading: '帳號限制已解除',
				description: '您的帳號限制已被解除，貼文將重新對所有人可見。',
			},
			enable: {
				subject: '帳號已重新啟用',
				heading: '帳號已重新啟用',
				description: '您的帳號已重新啟用，您可以重新登入。',
			},
			unsensitize: {
				subject: '敏感媒體標記已移除',
				heading: '敏感媒體標記已移除',
				description: '您的媒體的敏感內容標記已被移除。',
			},
		},
		reasonLabel: '原因',
	},
};

/**
 * Get email translations for a given locale. Falls back to English
 * if the locale is not available.
 */
export function getEmailTranslations(locale: string | unknown): EmailStrings {
	if (typeof locale !== 'string') return translations.en;
	return translations[locale] || translations.en;
}
