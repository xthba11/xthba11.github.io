(function () {
  var STORAGE_KEY = 'xthba_hidden_home_posts_v1'
  var PASSWORD = '123456'
  var HOME_PATH_RE = /^\/(?:page\/\d+\/?)?$/
  var ABOUT_PATH_RE = /^\/about\/?$/

  function isHomePage() {
    return HOME_PATH_RE.test(window.location.pathname)
  }

  function isAboutPage() {
    return ABOUT_PATH_RE.test(window.location.pathname)
  }

  function normalizePostId(href) {
    var url = new URL(href, window.location.origin)
    return url.pathname.replace(/\/$/, '')
  }

  function loadHiddenPosts() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY)
      return raw ? JSON.parse(raw) : []
    } catch (err) {
      console.warn('[post-shelf] failed to read localStorage', err)
      return []
    }
  }

  function saveHiddenPosts(posts) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(posts))
  }

  function ensureAuthorized() {
    var input = window.prompt('请输入文章上下架管理密码')
    if (input === PASSWORD) {
      return true
    }

    if (input !== null) {
      window.alert('密码错误，不能操作文章上下架。')
    }

    return false
  }

  function findPostCards() {
    return Array.prototype.slice.call(
      document.querySelectorAll('#recent-posts .recent-post-item:not(.ads-wrap)')
    )
  }

  function getCardInfo(card) {
    var titleLink = card.querySelector('.article-title')
    if (!titleLink) return null

    return {
      id: normalizePostId(titleLink.href),
      title: titleLink.textContent.trim() || '未命名文章',
      href: titleLink.href
    }
  }

  function getHiddenMap() {
    var map = {}
    loadHiddenPosts().forEach(function (post) {
      map[post.id] = post
    })
    return map
  }

  function addHiddenPost(post) {
    var posts = loadHiddenPosts()
    var exists = posts.some(function (item) {
      return item.id === post.id
    })

    if (!exists) {
      posts.unshift({
        id: post.id,
        title: post.title,
        href: post.href,
        hiddenAt: new Date().toISOString()
      })
      saveHiddenPosts(posts)
    }
  }

  function restorePost(postId) {
    var posts = loadHiddenPosts().filter(function (post) {
      return post.id !== postId
    })
    saveHiddenPosts(posts)
    renderShelfPanel()
    applyHiddenState()
  }

  function getShelfContainer() {
    if (isAboutPage()) {
      return document.querySelector('#page')
    }

    return null
  }

  function applyHiddenState() {
    var hiddenMap = getHiddenMap()
    var visibleCount = 0

    findPostCards().forEach(function (card) {
      var info = getCardInfo(card)
      if (!info) return

      var hidden = Boolean(hiddenMap[info.id])
      card.classList.toggle('post-shelf-hidden', hidden)

      if (!hidden) {
        visibleCount += 1
      }
    })

    var empty = document.querySelector('.post-shelf-empty-page')
    if (empty) {
      empty.hidden = visibleCount !== 0
    }
  }

  function addShelfButtons() {
    findPostCards().forEach(function (card) {
      if (card.querySelector('.post-shelf-off-btn')) return

      var info = getCardInfo(card)
      var infoBox = card.querySelector('.recent-post-info')
      if (!info || !infoBox) return

      var button = document.createElement('button')
      button.type = 'button'
      button.className = 'post-shelf-off-btn'
      button.textContent = '下架'
      button.title = '从首页隐藏这篇文章'

      button.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()

        if (!ensureAuthorized()) return

        addHiddenPost(info)
        applyHiddenState()
      })

      infoBox.appendChild(button)
    })
  }

  function renderShelfPanel() {
    var container = getShelfContainer()
    if (!container) return

    var oldPanel = document.querySelector('.post-shelf-panel')
    if (oldPanel) oldPanel.remove()

    var hiddenPosts = loadHiddenPosts()
    var panel = document.createElement('section')
    panel.className = 'post-shelf-panel post-shelf-panel--about'

    var header = document.createElement('div')
    header.className = 'post-shelf-panel__header'

    var title = document.createElement('div')
    title.className = 'post-shelf-panel__title'
    title.textContent = '下架文章'

    var count = document.createElement('span')
    count.className = 'post-shelf-panel__count'
    count.textContent = String(hiddenPosts.length)

    header.appendChild(title)
    header.appendChild(count)
    panel.appendChild(header)

    var tip = document.createElement('p')
    tip.className = 'post-shelf-panel__tip'
    tip.textContent = hiddenPosts.length
      ? '这些文章只是在当前浏览器首页隐藏，输入密码后点击“重新上架”即可恢复。'
      : '暂无下架文章。需要整理首页时，可以回到主页点击文章卡片右下角的“下架”。'
    panel.appendChild(tip)

    if (hiddenPosts.length) {
      var list = document.createElement('div')
      list.className = 'post-shelf-list'

      hiddenPosts.forEach(function (post) {
        var item = document.createElement('div')
        item.className = 'post-shelf-list__item'

        var link = document.createElement('a')
        link.className = 'post-shelf-list__title'
        link.href = post.href
        link.textContent = post.title

        var restore = document.createElement('button')
        restore.type = 'button'
        restore.className = 'post-shelf-on-btn'
        restore.textContent = '重新上架'
        restore.addEventListener('click', function () {
          if (!ensureAuthorized()) return
          restorePost(post.id)
        })

        item.appendChild(link)
        item.appendChild(restore)
        list.appendChild(item)
      })

      panel.appendChild(list)
    }

    container.appendChild(panel)
  }

  function initPostShelf() {
    if (isHomePage()) {
      if (!document.getElementById('recent-posts')) return

      addShelfButtons()
      applyHiddenState()
      return
    }

    if (isAboutPage()) {
      renderShelfPanel()
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPostShelf)
  } else {
    initPostShelf()
  }

  document.addEventListener('pjax:complete', initPostShelf)
})()
