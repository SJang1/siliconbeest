(function () {
  var TOKEN_KEY = 'siliconbeest_token';

  function writeTokenCookie(token) {
    var secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = TOKEN_KEY + '=' + encodeURIComponent(token) + '; Path=/; Max-Age=2592000; SameSite=Lax' + secure;
  }

  function clearTokenCookie() {
    var secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = TOKEN_KEY + '=; Path=/; Max-Age=0; SameSite=Lax' + secure;
  }

  function getVueReady() {
    return window.__SILICONBEEST_LOGIN_VUE_READY__ === true;
  }

  function setError(message) {
    var error = document.getElementById('login-static-error');
    if (!error) return;
    error.textContent = message || '';
    error.classList.toggle('hidden', !message);
  }

  function setLoading(form, loading) {
    var button = form.querySelector('[data-login-submit]');
    if (!button) return;
    button.disabled = loading;
    button.textContent = loading ? '로딩 중...' : '로그인';
  }

  function getString(formData, key) {
    var value = formData.get(key);
    return typeof value === 'string' ? value : '';
  }

  function getDesignPath(path) {
    if (window.location.pathname === '/old/login') return '/old' + path;
    if (window.location.pathname === '/aurora/login') return '/aurora' + path;
    return path;
  }

  function getSafeRedirect(value) {
    if (!value || value.charAt(0) !== '/' || value.indexOf('//') === 0) {
      return getDesignPath('/home');
    }

    try {
      var parsed = new URL(value, window.location.origin);
      if (parsed.origin !== window.location.origin) return getDesignPath('/home');
      return parsed.pathname + parsed.search + parsed.hash;
    } catch (_error) {
      return getDesignPath('/home');
    }
  }

  async function submitLogin(form, event) {
    if (getVueReady()) return;

    event.preventDefault();
    event.stopPropagation();

    if (form.dataset.loginSubmitting === 'true') return;

    var formData = new FormData(form);
    var username = getString(formData, 'username').trim();
    var password = getString(formData, 'password');

    if (!username || !password) {
      setError('사용자 이름과 비밀번호를 입력해 주세요.');
      return;
    }

    form.dataset.loginSubmitting = 'true';
    setError('');
    setLoading(form, true);

    try {
      var response = await fetch(form.dataset.loginEndpoint || '/api/v1/auth/login', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: username,
          password: password,
        }),
      });
      var data = await response.json().catch(function () {
        return {};
      });

      if (!response.ok) {
        throw new Error(data.error_description || data.error || '로그인에 실패했습니다.');
      }

      var params = new URLSearchParams(window.location.search);
      if (data.registration_required === true) {
        clearTokenCookie();
        window.location.assign(getDesignPath('/auth/registration'));
        return;
      }

      if (!data.access_token || typeof data.access_token !== 'string') {
        throw new Error('로그인 응답이 올바르지 않습니다.');
      }

      writeTokenCookie(data.access_token);
      window.location.assign(getSafeRedirect(params.get('redirect')));
    } catch (error) {
      setError(error && error.message ? error.message : '로그인에 실패했습니다.');
      form.dataset.loginSubmitting = 'false';
      setLoading(form, false);
    }
  }

  function bind() {
    var form = document.getElementById('login-form');
    if (!form || form.dataset.staticLoginBound === 'true') return;

    form.dataset.staticLoginBound = 'true';
    form.addEventListener('submit', function (event) {
      submitLogin(form, event);
    }, true);

    var button = form.querySelector('[data-login-submit]');
    if (button) {
      button.addEventListener('click', function (event) {
        submitLogin(form, event);
      }, true);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
