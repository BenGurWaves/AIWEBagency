/* ═══════════════════════════════════════════════════════════
   VELOCITY — Dashboard SPA
   Hash-based routing. Auth via session cookies.
   ═══════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var app = document.getElementById('app');
  var state = {
    user: null,
    projects: [],
    loading: true,
  };

  // ── Routing ─────────────────────────────────────────────

  function getRoute() {
    var hash = location.hash.slice(1) || '';
    var qIdx = hash.indexOf('?');
    var path = qIdx > -1 ? hash.slice(0, qIdx) : hash;
    var params = {};
    if (qIdx > -1) {
      hash.slice(qIdx + 1).split('&').forEach(function (p) {
        var kv = p.split('=');
        params[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
      });
    }
    return { path: path, params: params };
  }

  function navigate(hash) {
    location.hash = hash;
  }

  window.addEventListener('hashchange', render);

  // ── API helpers ─────────────────────────────────────────

  function api(method, path, body) {
    var opts = {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    };
    if (body) opts.body = JSON.stringify(body);
    return fetch(path, opts).then(function (r) {
      return r.json().then(function (data) {
        data._status = r.status;
        return data;
      });
    });
  }

  // ── Auth check ──────────────────────────────────────────

  function checkAuth() {
    return api('GET', '/api/auth/me').then(function (data) {
      if (data._status === 200) {
        state.user = data;
        return true;
      }
      state.user = null;
      return false;
    }).catch(function () {
      state.user = null;
      return false;
    });
  }

  // ── Load projects ───────────────────────────────────────

  function loadProjects() {
    return api('GET', '/api/projects').then(function (data) {
      state.projects = data.projects || [];
    }).catch(function () {
      state.projects = [];
    });
  }

  // ── Render ──────────────────────────────────────────────

  function render() {
    var route = getRoute();

    if (state.loading) {
      app.innerHTML = renderLoading();
      return;
    }

    if (!state.user) {
      if (route.path === 'signup') {
        app.innerHTML = renderHeader(false) + renderSignup(route.params);
      } else {
        app.innerHTML = renderHeader(false) + renderLogin(route.params);
      }
    } else {
      if (route.path.indexOf('project/') === 0) {
        var projectId = route.path.split('/')[1];
        app.innerHTML = renderHeader(true) + renderProjectDetail(projectId);
      } else if (route.path === 'plans') {
        app.innerHTML = renderHeader(true) + renderPlans();
      } else {
        app.innerHTML = renderHeader(true) + renderDashboard();
      }
    }

    bindEvents();
  }

  // ── Templates ───────────────────────────────────────────

  function renderLoading() {
    return '<div class="loading-screen"><div class="spinner"></div></div>';
  }

  function renderHeader(loggedIn) {
    var right = '';
    if (loggedIn && state.user) {
      right =
        '<div class="app-header-right">' +
          '<span class="app-plan-badge">' + esc(state.user.plan || 'free') + '</span>' +
          '<span class="app-user">' + esc(state.user.email) + '</span>' +
          '<a href="#plans" class="btn btn-ghost btn-sm">Plans</a>' +
          '<button class="btn btn-ghost btn-sm" id="logoutBtn">Log out</button>' +
        '</div>';
    }
    return (
      '<header class="app-header">' +
        '<div style="display:flex;flex-direction:column;line-height:1;"><a href="/" class="app-logo">Velocity<span class="app-logo-dot">.</span><span class="app-logo-badge">Dashboard</span></a><a href="https://calyvent.com" target="_blank" style="font-size:9px;color:#6d6560;font-family:sans-serif;text-decoration:none;margin-top:2px;">by Calyvent</a></div>' +
        right +
      '</header>'
    );
  }

  function renderLogin(params) {
    return (
      '<div class="auth-wrapper">' +
        '<div class="auth-card">' +
          '<h1>Welcome <em>back.</em></h1>' +
          '<p class="auth-subtitle">Log in to see your projects and previews.</p>' +
          '<div class="auth-error" id="authError"></div>' +
          '<form class="auth-form" id="loginForm">' +
            '<div class="form-group">' +
              '<label for="loginEmail">Email</label>' +
              '<input type="email" id="loginEmail" placeholder="you@business.com" required value="' + esc(params.email || '') + '">' +
            '</div>' +
            '<div class="form-group">' +
              '<label for="loginPass">Password</label>' +
              '<input type="password" id="loginPass" placeholder="Your password" required>' +
            '</div>' +
            '<button type="submit" class="btn btn-primary btn-full" id="loginBtn">Log in</button>' +
          '</form>' +
          '<p class="auth-switch">Don\'t have an account? <a href="#signup">Sign up</a></p>' +
        '</div>' +
      '</div>'
    );
  }

  function renderSignup(params) {
    return (
      '<div class="auth-wrapper">' +
        '<div class="auth-card">' +
          '<h1>Create your <em>account.</em></h1>' +
          '<p class="auth-subtitle">See your free redesign preview and manage your website projects.</p>' +
          '<div class="auth-error" id="authError"></div>' +
          '<form class="auth-form" id="signupForm">' +
            '<div class="form-group">' +
              '<label for="signupEmail">Email</label>' +
              '<input type="email" id="signupEmail" placeholder="you@business.com" required value="' + esc(params.email || '') + '">' +
            '</div>' +
            '<div class="form-group">' +
              '<label for="signupPass">Password</label>' +
              '<input type="password" id="signupPass" placeholder="At least 6 characters" required minlength="6">' +
            '</div>' +
            '<div class="form-group">' +
              '<label for="signupPass2">Confirm password</label>' +
              '<input type="password" id="signupPass2" placeholder="Type password again" required minlength="6">' +
            '</div>' +
            '<div class="form-group">' +
              '<label for="signupUrl">Your website URL</label>' +
              '<input type="url" id="signupUrl" placeholder="https://yourbusiness.com" value="' + esc(params.url || '') + '">' +
            '</div>' +
            '<button type="submit" class="btn btn-primary btn-full" id="signupBtn">Create account</button>' +
          '</form>' +
          '<p class="auth-switch">Already have an account? <a href="#login">Log in</a></p>' +
        '</div>' +
      '</div>'
    );
  }

  function renderDashboard() {
    var projectsHtml = '';

    if (state.projects.length === 0) {
      projectsHtml =
        '<div class="empty-state">' +
          '<div class="empty-state-icon">&#127760;</div>' +
          '<h3>No projects yet.</h3>' +
          '<p>Submit your website URL and we\'ll build you a free redesign preview.</p>' +
          '<button class="btn btn-primary" id="newProjectBtn">New project</button>' +
        '</div>';
    } else {
      projectsHtml = '<div class="project-grid">';
      state.projects.forEach(function (p) {
        var statusClass = 'status-' + (p.status || 'queued');
        var statusLabel = p.status === 'preview_ready' ? 'Preview Ready' : p.status === 'queued' ? 'Queued' : p.status === 'analyzing' ? 'Analyzing' : p.status === 'deployed' ? 'Live' : (p.status || 'Queued');
        projectsHtml +=
          '<div class="project-card" data-project="' + esc(p.id) + '">' +
            '<div class="project-card-url">' + esc(p.website_url) + '</div>' +
            '<span class="project-card-status ' + statusClass + '">' + esc(statusLabel) + '</span>' +
            '<div class="progress-bar"><div class="progress-fill" style="width:' + (p.progress || 0) + '%"></div></div>' +
            '<div class="project-card-date">Created ' + formatDate(p.created_at) + '</div>' +
          '</div>';
      });
      projectsHtml += '</div>';
    }

    return (
      '<div class="dash-main">' +
        '<div class="dash-header">' +
          '<h1>Your <em>projects.</em></h1>' +
          '<button class="btn btn-primary" id="newProjectBtn">+ New project</button>' +
        '</div>' +
        projectsHtml +
      '</div>'
    );
  }

  function renderProjectDetail(projectId) {
    var p = null;
    for (var i = 0; i < state.projects.length; i++) {
      if (state.projects[i].id === projectId) {
        p = state.projects[i];
        break;
      }
    }

    if (!p) {
      return (
        '<div class="dash-main">' +
          '<div class="back-link" id="backBtn">&#8592; Back to dashboard</div>' +
          '<p>Project not found.</p>' +
        '</div>'
      );
    }

    var statusClass = 'status-' + (p.status || 'queued');
    var statusLabel = p.status === 'preview_ready' ? 'Preview Ready' : p.status === 'queued' ? 'Queued' : p.status === 'analyzing' ? 'Analyzing' : p.status === 'deployed' ? 'Live' : (p.status || 'Queued');

    var bizName = (p.business_info && p.business_info.name) ? p.business_info.name : 'Website';

    var detailCards =
      '<div class="detail-grid">' +
        '<div class="detail-card">' +
          '<h3>Progress</h3>' +
          '<div class="big-num">' + (p.progress || 0) + '%</div>' +
          '<div class="progress-bar" style="margin-top:0.75rem"><div class="progress-fill" style="width:' + (p.progress || 0) + '%"></div></div>' +
        '</div>' +
        '<div class="detail-card">' +
          '<h3>Status</h3>' +
          '<span class="project-card-status ' + statusClass + '" style="font-size:0.75rem;padding:4px 12px">' + esc(statusLabel) + '</span>' +
          (p.business_info ? '<p style="margin-top:0.75rem;font-size:0.8125rem;color:var(--text-secondary)">' + esc(p.business_info.name || '') + '</p>' : '') +
        '</div>' +
      '</div>';

    var previewHtml = '';
    if (p.status === 'preview_ready' || p.status === 'deployed') {
      previewHtml =
        '<div class="preview-frame">' +
          '<div class="preview-frame-bar">' +
            '<div class="preview-frame-dots"><span></span><span></span><span></span></div>' +
            '<div class="preview-frame-url">' + esc(bizName) + ' 2.0 — Preview</div>' +
          '</div>' +
          '<iframe src="/preview/' + esc(p.id) + '" title="Preview"></iframe>' +
        '</div>';
    }

    var actionsHtml = '<div class="detail-actions">';
    if (p.status === 'queued') {
      actionsHtml += '<button class="btn btn-primary" id="analyzeBtn" data-id="' + esc(p.id) + '">Start analysis</button>';
    }
    if (p.status === 'preview_ready') {
      actionsHtml += '<a href="/preview/' + esc(p.id) + '" target="_blank" class="btn btn-ghost">Open preview</a>';
      actionsHtml += '<button class="btn btn-primary" id="deployBtn" data-id="' + esc(p.id) + '">Approve &amp; deploy</button>';
    }
    if (p.status === 'deployed' && p.live_url) {
      actionsHtml += '<a href="' + esc(p.live_url) + '" target="_blank" class="btn btn-primary">Visit live site</a>';
    }
    actionsHtml += '</div>';

    return (
      '<div class="project-detail">' +
        '<div class="back-link" id="backBtn">&#8592; Back to dashboard</div>' +
        '<div class="detail-header">' +
          '<h1>' + esc(bizName) + ' <span style="color:var(--accent)">2.0</span></h1>' +
          '<p>' + esc(p.website_url) + '</p>' +
        '</div>' +
        detailCards +
        previewHtml +
        actionsHtml +
      '</div>'
    );
  }

  function renderPlans() {
    var currentPlan = (state.user && state.user.plan) || 'free';

    function planCard(name, price, period, features, isCurrent) {
      return (
        '<div class="plan-card' + (isCurrent ? ' active' : '') + '">' +
          '<h3>' + name + '</h3>' +
          '<div class="plan-price">' + price + ' <span>' + period + '</span></div>' +
          '<ul>' + features.map(function (f) { return '<li>' + f + '</li>'; }).join('') + '</ul>' +
          (isCurrent ? '<span class="active-badge">Current plan</span>' : '<button class="btn btn-ghost btn-sm btn-full">Coming soon</button>') +
        '</div>'
      );
    }

    return (
      '<div class="dash-main">' +
        '<div class="dash-header">' +
          '<h1>Your <em>plan.</em></h1>' +
          '<a href="#dashboard" class="btn btn-ghost btn-sm">&#8592; Dashboard</a>' +
        '</div>' +
        '<div class="plans-grid">' +
          planCard('Free', '$0', '', ['1 project', 'Preview generation', 'Basic analytics'], currentPlan === 'free') +
          planCard('Starter', '$997', 'one-time', ['5-page custom website', 'Mobile-first design', 'SSL included', 'Basic SEO', '30 days support'], currentPlan === 'starter') +
          planCard('Professional', '$1,997', 'one-time', ['Multi-page website', 'Blog with CMS', 'Advanced SEO', 'Service area pages', '60 days support'], currentPlan === 'professional') +
        '</div>' +
      '</div>'
    );
  }

  function renderNewProjectModal() {
    return (
      '<div class="modal-overlay" id="modalOverlay">' +
        '<div class="modal-card">' +
          '<h2>New project</h2>' +
          '<p>Enter the URL of the website you want redesigned.</p>' +
          '<div class="auth-error" id="modalError"></div>' +
          '<form id="newProjectForm">' +
            '<div class="form-group">' +
              '<label for="newProjectUrl">Website URL</label>' +
              '<input type="url" id="newProjectUrl" placeholder="https://yourbusiness.com" required>' +
            '</div>' +
            '<div class="modal-actions">' +
              '<button type="button" class="btn btn-ghost" id="modalCancel">Cancel</button>' +
              '<button type="submit" class="btn btn-primary">Create project</button>' +
            '</div>' +
          '</form>' +
        '</div>' +
      '</div>'
    );
  }

  // ── Event Binding ───────────────────────────────────────

  function bindEvents() {
    // Login form
    var loginForm = document.getElementById('loginForm');
    if (loginForm) {
      loginForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var btn = document.getElementById('loginBtn');
        var errEl = document.getElementById('authError');
        var email = document.getElementById('loginEmail').value.trim();
        var pass = document.getElementById('loginPass').value;

        btn.disabled = true;
        btn.textContent = 'Logging in...';
        errEl.className = 'auth-error';

        api('POST', '/api/auth/login', { email: email, password: pass }).then(function (data) {
          if (!data.success) {
            throw new Error(data.error || 'Login failed');
          }
          return checkAuth();
        }).then(function () {
          return loadProjects();
        }).then(function () {
          navigate('dashboard');
        }).catch(function (e) {
          errEl.textContent = e.message || 'Network error. Please try again.';
          errEl.className = 'auth-error visible';
          btn.disabled = false;
          btn.textContent = 'Log in';
        });
      });
    }

    // Signup form
    var signupForm = document.getElementById('signupForm');
    if (signupForm) {
      signupForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var btn = document.getElementById('signupBtn');
        var errEl = document.getElementById('authError');
        var email = document.getElementById('signupEmail').value.trim();
        var pass = document.getElementById('signupPass').value;
        var pass2 = document.getElementById('signupPass2').value;
        var url = document.getElementById('signupUrl').value.trim();

        if (pass !== pass2) {
          errEl.textContent = 'Passwords do not match.';
          errEl.className = 'auth-error visible';
          return;
        }

        btn.disabled = true;
        btn.textContent = 'Creating account...';
        errEl.className = 'auth-error';

        var _projectId;
        api('POST', '/api/auth/signup', { email: email, password: pass, website_url: url }).then(function (data) {
          if (!data.success) {
            throw new Error(data.error || 'Signup failed');
          }
          _projectId = data.project_id;
          return checkAuth();
        }).then(function () {
          return loadProjects();
        }).then(function () {
          if (_projectId && state.projects.length > 0) {
            triggerAnalysis(_projectId);
          }
          navigate('dashboard');
        }).catch(function (e) {
          errEl.textContent = e.message || 'Network error. Please try again.';
          errEl.className = 'auth-error visible';
          btn.disabled = false;
          btn.textContent = 'Create account';
        });
      });
    }

    // Logout
    var logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', function () {
        api('POST', '/api/auth/logout').then(function () {
          state.user = null;
          state.projects = [];
          navigate('login');
        });
      });
    }

    // Project card clicks
    var cards = document.querySelectorAll('.project-card');
    cards.forEach(function (card) {
      card.addEventListener('click', function () {
        var id = card.getAttribute('data-project');
        navigate('project/' + id);
      });
    });

    // Back button
    var backBtn = document.getElementById('backBtn');
    if (backBtn) {
      backBtn.addEventListener('click', function () {
        navigate('dashboard');
      });
    }

    // New project button
    var newProjectBtn = document.getElementById('newProjectBtn');
    if (newProjectBtn) {
      newProjectBtn.addEventListener('click', function () {
        app.insertAdjacentHTML('beforeend', renderNewProjectModal());
        bindModalEvents();
      });
    }

    // Analyze button
    var analyzeBtn = document.getElementById('analyzeBtn');
    if (analyzeBtn) {
      analyzeBtn.addEventListener('click', function () {
        var id = analyzeBtn.getAttribute('data-id');
        analyzeBtn.disabled = true;
        analyzeBtn.innerHTML = '<span class="spinner"></span> Analyzing...';
        triggerAnalysis(id);
      });
    }

    // Deploy button
    var deployBtn = document.getElementById('deployBtn');
    if (deployBtn) {
      deployBtn.addEventListener('click', function () {
        var id = deployBtn.getAttribute('data-id');
        deployBtn.disabled = true;
        deployBtn.innerHTML = '<span class="spinner"></span> Deploying...';
        api('POST', '/api/pipeline/deploy', { project_id: id }).then(function (data) {
          if (data.project) {
            updateProjectInState(data.project);
          }
          render();
        }).catch(function () {
          deployBtn.disabled = false;
          deployBtn.textContent = 'Approve & deploy';
        });
      });
    }
  }

  function bindModalEvents() {
    var overlay = document.getElementById('modalOverlay');
    var cancel = document.getElementById('modalCancel');
    var form = document.getElementById('newProjectForm');

    if (cancel) {
      cancel.addEventListener('click', function () {
        overlay.remove();
      });
    }

    if (overlay) {
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) overlay.remove();
      });
    }

    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var url = document.getElementById('newProjectUrl').value.trim();
        var errEl = document.getElementById('modalError');

        if (!url) return;

        api('POST', '/api/projects', { website_url: url }).then(function (data) {
          if (data.success && data.project) {
            state.projects.push(data.project);
            overlay.remove();
            // Auto-trigger analysis
            triggerAnalysis(data.project.id);
            render();
          } else {
            errEl.textContent = data.error || 'Failed to create project';
            errEl.className = 'auth-error visible';
          }
        }).catch(function () {
          errEl.textContent = 'Network error.';
          errEl.className = 'auth-error visible';
        });
      });
    }
  }

  // ── Pipeline ────────────────────────────────────────────

  function triggerAnalysis(projectId) {
    api('POST', '/api/pipeline/analyze', { project_id: projectId }).then(function (data) {
      if (data.project) {
        updateProjectInState(data.project);
      }
      render();
    }).catch(function () {
      // Reload projects to get latest state
      loadProjects().then(render);
    });
  }

  function updateProjectInState(updated) {
    for (var i = 0; i < state.projects.length; i++) {
      if (state.projects[i].id === updated.id) {
        state.projects[i] = updated;
        return;
      }
    }
    state.projects.push(updated);
  }

  // ── Utilities ───────────────────────────────────────────

  function esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDate(isoStr) {
    if (!isoStr) return '';
    try {
      var d = new Date(isoStr);
      var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
    } catch {
      return isoStr;
    }
  }

  // ── Init ────────────────────────────────────────────────

  checkAuth().then(function (loggedIn) {
    if (loggedIn) {
      return loadProjects().then(function () {
        state.loading = false;
        var route = getRoute();
        if (!route.path || route.path === 'login' || route.path === 'signup') {
          navigate('dashboard');
        }
        render();
      });
    } else {
      state.loading = false;
      var route = getRoute();
      if (!route.path) {
        navigate('login');
      }
      render();
    }
  });

})();
