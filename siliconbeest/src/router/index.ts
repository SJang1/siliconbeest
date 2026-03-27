import { createRouter, createWebHistory } from 'vue-router';
import { requireAuth, requireAdmin, redirectIfAuthenticated } from './guards';
import { useInstanceStore } from '@/stores/instance';

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  scrollBehavior(_to, _from, savedPosition) {
    return savedPosition ?? { top: 0 };
  },
  routes: [
    // Landing page (shown when not logged in)
    {
      path: '/',
      name: 'landing',
      component: () => import('@/views/LandingView.vue'),
      beforeEnter: redirectIfAuthenticated,
    },
    // Authenticated home
    {
      path: '/home',
      name: 'home',
      component: () => import('@/views/HomeView.vue'),
      beforeEnter: requireAuth,
      meta: { titleKey: 'Home' },
    },
    {
      path: '/explore',
      name: 'explore',
      redirect: '/explore/local',
    },
    {
      path: '/explore/:tab(local|public)',
      name: 'explore-tab',
      component: () => import('@/views/ExploreView.vue'),
      meta: { titleKey: 'Explore' },
    },
    {
      path: '/about',
      name: 'about',
      component: () => import('@/views/AboutView.vue'),
      meta: { titleKey: 'About' },
    },
    {
      path: '/about/more',
      name: 'about-more',
      component: () => import('@/views/AboutView.vue'),
      meta: { titleKey: 'About' },
    },
    {
      path: '/search',
      name: 'search',
      component: () => import('@/views/SearchView.vue'),
      meta: { titleKey: 'Search' },
    },
    {
      path: '/tags/:tag',
      name: 'tag',
      component: () => import('@/views/TagTimelineView.vue'),
      props: true,
    },

    // Auth routes
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      beforeEnter: redirectIfAuthenticated,
      meta: { titleKey: 'Login' },
    },
    {
      path: '/register',
      name: 'register',
      component: () => import('@/views/RegisterView.vue'),
      beforeEnter: redirectIfAuthenticated,
      meta: { titleKey: 'Register' },
    },
    {
      path: '/oauth/authorize',
      name: 'oauth-authorize',
      component: () => import('@/views/OAuthAuthorizeView.vue'),
    },
    {
      path: '/auth/forgot-password',
      name: 'forgot-password',
      component: () => import('@/views/ForgotPasswordView.vue'),
    },
    {
      path: '/auth/reset-password',
      name: 'reset-password',
      component: () => import('@/views/ResetPasswordView.vue'),
    },
    {
      path: '/auth/confirm-email-sent',
      name: 'confirm-email-sent',
      component: () => import('@/views/ConfirmEmailSentView.vue'),
    },

    // Authenticated routes
    {
      path: '/notifications',
      name: 'notifications',
      component: () => import('@/views/NotificationsView.vue'),
      beforeEnter: requireAuth,
      meta: { titleKey: 'Notifications' },
    },
    {
      path: '/conversations',
      name: 'conversations',
      component: () => import('@/views/ConversationsView.vue'),
      beforeEnter: requireAuth,
      meta: { titleKey: 'Conversations' },
    },
    {
      path: '/bookmarks',
      name: 'bookmarks',
      component: () => import('@/views/BookmarksView.vue'),
      beforeEnter: requireAuth,
      meta: { titleKey: 'Bookmarks' },
    },
    {
      path: '/favourites',
      name: 'favourites',
      component: () => import('@/views/FavouritesView.vue'),
      beforeEnter: requireAuth,
      meta: { titleKey: 'Favourites' },
    },
    {
      path: '/lists',
      name: 'lists',
      component: () => import('@/views/ListsView.vue'),
      beforeEnter: requireAuth,
      meta: { titleKey: 'Lists' },
    },
    {
      path: '/lists/:id',
      name: 'list-timeline',
      component: () => import('@/views/ListTimelineView.vue'),
      beforeEnter: requireAuth,
      props: true,
    },
    {
      path: '/follow-requests',
      name: 'follow-requests',
      component: () => import('@/views/FollowRequestsView.vue'),
      beforeEnter: requireAuth,
    },

    // Settings routes
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/SettingsView.vue'),
      beforeEnter: requireAuth,
      meta: { titleKey: 'Settings' },
      children: [
        {
          path: '',
          redirect: { name: 'settings-profile' },
        },
        {
          path: 'profile',
          name: 'settings-profile',
          component: () => import('@/views/SettingsProfileView.vue'),
        },
        {
          path: 'account',
          name: 'settings-account',
          component: () => import('@/views/SettingsAccountView.vue'),
        },
        {
          path: 'appearance',
          name: 'settings-appearance',
          component: () => import('@/views/SettingsAppearanceView.vue'),
        },
        {
          path: 'notifications',
          name: 'settings-notifications',
          component: () => import('@/views/SettingsNotificationsView.vue'),
        },
        {
          path: 'filters',
          name: 'settings-filters',
          component: () => import('@/views/SettingsFiltersView.vue'),
        },
        {
          path: 'migration',
          name: 'settings-migration',
          component: () => import('@/views/SettingsMigrationView.vue'),
        },
        {
          path: 'security',
          name: 'settings-security',
          component: () => import('@/views/SettingsSecurityView.vue'),
        },
      ],
    },

    // Admin routes
    {
      path: '/admin',
      beforeEnter: requireAdmin,
      children: [
        {
          path: '',
          name: 'admin-dashboard',
          component: () => import('@/views/AdminDashboardView.vue'),
        },
        {
          path: 'accounts',
          name: 'admin-accounts',
          component: () => import('@/views/AdminAccountsView.vue'),
        },
        {
          path: 'reports',
          name: 'admin-reports',
          component: () => import('@/views/AdminReportsView.vue'),
        },
        {
          path: 'domain-blocks',
          name: 'admin-domain-blocks',
          component: () => import('@/views/AdminDomainBlocksView.vue'),
        },
        {
          path: 'settings',
          name: 'admin-settings',
          component: () => import('@/views/AdminSettingsView.vue'),
        },
        {
          path: 'announcements',
          name: 'admin-announcements',
          component: () => import('@/views/AdminAnnouncementsView.vue'),
        },
        {
          path: 'rules',
          name: 'admin-rules',
          component: () => import('@/views/AdminRulesView.vue'),
        },
        {
          path: 'relays',
          name: 'admin-relays',
          component: () => import('@/views/AdminRelaysView.vue'),
        },
        {
          path: 'custom-emojis',
          name: 'admin-custom-emojis',
          component: () => import('@/views/AdminCustomEmojisView.vue'),
        },
        {
          path: 'federation',
          name: 'admin-federation',
          component: () => import('@/views/AdminFederationView.vue'),
        },
      ],
    },

    // Profile & status detail (must be near the bottom for catch-all patterns)
    {
      path: '/@:acct',
      name: 'profile',
      component: () => import('@/views/ProfileView.vue'),
      props: true,
    },
    {
      path: '/@:acct/followers',
      name: 'profile-followers',
      component: () => import('@/views/FollowListView.vue'),
      props: true,
    },
    {
      path: '/@:acct/following',
      name: 'profile-following',
      component: () => import('@/views/FollowListView.vue'),
      props: true,
    },
    {
      path: '/@:acct/:statusId',
      name: 'status-detail',
      component: () => import('@/views/StatusDetailView.vue'),
      props: true,
    },
    // Handle %40 encoded @ in URLs (direct browser access)
    {
      path: '/%40:acct',
      redirect: (to) => ({ name: 'profile', params: { acct: to.params.acct } }),
    },
    {
      path: '/%40:acct/followers',
      redirect: (to) => ({ name: 'profile-followers', params: { acct: to.params.acct } }),
    },
    {
      path: '/%40:acct/following',
      redirect: (to) => ({ name: 'profile-following', params: { acct: to.params.acct } }),
    },
    {
      path: '/%40:acct/:statusId',
      redirect: (to) => ({ name: 'status-detail', params: { acct: to.params.acct, statusId: to.params.statusId } }),
    },

    // 404
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/views/NotFoundView.vue'),
    },
  ],
});

// Handle chunk load failures after deployments (hash mismatch)
router.onError((error, to) => {
  const chunkFailedMessage = /Loading chunk|Failed to fetch dynamically imported module|import/i;
  if (chunkFailedMessage.test(error.message)) {
    window.location.href = to.fullPath;
  }
});

// Dynamic page titles based on route meta
router.afterEach((to) => {
  const instanceStore = useInstanceStore();
  const siteName = instanceStore.instance?.title || 'SiliconBeest';
  const titleKey = to.meta.titleKey as string | undefined;

  if (titleKey) {
    document.title = `${titleKey} | ${siteName}`;
  }
  // Profile and status views set their own title after data loads
  // (see ProfileView.vue and StatusDetailView.vue)
});

export default router;
