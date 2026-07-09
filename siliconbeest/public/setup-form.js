(function () {
  var TOKEN_KEY = 'siliconbeest_token';

  function writeTokenCookie(token) {
    var secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = TOKEN_KEY + '=' + encodeURIComponent(token) + '; Path=/; Max-Age=2592000; SameSite=Lax' + secure;
  }

  function getVueReady() {
    return window.__SILICONBEEST_SETUP_VUE_READY__ === true;
  }

  function setError(message) {
    var error = document.getElementById('setup-static-error');
    if (!error) return;
    error.textContent = message || '';
    error.classList.toggle('hidden', !message);
  }

  function setLoading(form, loading) {
    var button = form.querySelector('[data-setup-submit]');
    if (!button) return;
    button.disabled = loading;
    button.textContent = loading ? '생성 중...' : '관리자 생성';
  }

  function getString(formData, key) {
    var value = formData.get(key);
    return typeof value === 'string' ? value : '';
  }

  function validate(formData) {
    var username = getString(formData, 'username').trim();
    var email = getString(formData, 'email').trim();
    var password = getString(formData, 'password');
    var confirmPassword = getString(formData, 'confirmPassword');
    var setupSecret = getString(formData, 'setup_secret');

    if (!username) return '사용자 이름을 입력해 주세요.';
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return '사용자 이름은 영문, 숫자, 밑줄만 사용할 수 있습니다.';
    if (!email) return '이메일을 입력해 주세요.';
    if (!setupSecret) return '설정 시크릿을 입력해 주세요.';
    if (!password) return '비밀번호를 입력해 주세요.';
    if (password.length < 8) return '비밀번호는 8자 이상이어야 합니다.';
    if (password !== confirmPassword) return '비밀번호 확인이 일치하지 않습니다.';
    return null;
  }

  async function submitSetup(form, event) {
    if (getVueReady()) return;

    event.preventDefault();
    event.stopPropagation();

    if (form.dataset.setupSubmitting === 'true') return;

    var formData = new FormData(form);
    var validationError = validate(formData);
    if (validationError) {
      setError(validationError);
      return;
    }

    form.dataset.setupSubmitting = 'true';
    setError('');
    setLoading(form, true);

    try {
      var response = await fetch(form.dataset.setupEndpoint || '/api/v1/setup', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: getString(formData, 'username').trim(),
          email: getString(formData, 'email').trim(),
          password: getString(formData, 'password'),
          locale: getString(formData, 'locale'),
          setup_secret: getString(formData, 'setup_secret'),
        }),
      });
      var data = await response.json().catch(function () {
        return {};
      });

      if (!response.ok) {
        throw new Error(data.error_description || data.error || '관리자 생성에 실패했습니다.');
      }

      writeTokenCookie(data.access_token);
      window.location.assign('/home');
    } catch (error) {
      setError(error && error.message ? error.message : '관리자 생성에 실패했습니다.');
      form.dataset.setupSubmitting = 'false';
      setLoading(form, false);
    }
  }

  function bind() {
    var form = document.getElementById('setup-admin-form');
    if (!form || form.dataset.staticSetupBound === 'true') return;

    form.dataset.staticSetupBound = 'true';
    form.addEventListener('submit', function (event) {
      submitSetup(form, event);
    }, true);

    var button = form.querySelector('[data-setup-submit]');
    if (button) {
      button.addEventListener('click', function (event) {
        submitSetup(form, event);
      }, true);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
