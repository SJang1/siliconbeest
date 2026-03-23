import { createRouter, createWebHistory } from 'vue-router';
import { requireAuth, requireAdmin, redirectIfAuthenticated } from './guards';

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
    },
    {
      path: '/explore',
      name: 'explore',
      component: () => import('@/views/ExploreView.vue'),
    },
    {
      path: '/about',
      name: 'about',
      component: () => import('@/views/AboutView.vue'),
    },
    {
      path: '/search',
      name: 'search',
      component: () => import('@/views/SearchView.vue'),
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
    },
    {
      path: '/register',
      name: 'register',
      component: () => import('@/views/RegisterView.vue'),
      beforeEnter: redirectIfAuthenticated,
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

    // Authenticated routes
    {
      path: '/notifications',
      name: 'notifications',
      component: () => import('@/views/NotificationsView.vue'),
      beforeEnter: requireAuth,
    },
    {
      path: '/conversations',
      name: 'conversations',
      component: () => import('@/views/ConversationsView.vue'),
      beforeEnter: requireAuth,
    },
    {
      path: '/bookmarks',
      name: 'bookmarks',
      component: () => import('@/views/BookmarksView.vue'),
      beforeEnter: requireAuth,
    },
    {
      path: '/favourites',
      name: 'favourites',
      component: () => import('@/views/FavouritesView.vue'),
      beforeEnter: requireAuth,
    },
    {
      path: '/lists',
      name: 'lists',
      component: () => import('@/views/ListsView.vue'),
      beforeEnter: requireAuth,
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
      path: '/@:acct/:statusId',
      name: 'status-detail',
      component: () => import('@/views/StatusDetailView.vue'),
      props: true,
    },

    // 404
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/views/NotFoundView.vue'),
    },
  ],
});

export default router;
