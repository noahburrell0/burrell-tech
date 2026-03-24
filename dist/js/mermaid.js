/* Mermaid diagram initialization with themed light/dark colors */
(function () {
  var blocks = document.querySelectorAll('code.language-mermaid');
  if (!blocks.length) return;

  var sources = [];
  for (var i = 0; i < blocks.length; i++) {
    var pre = blocks[i].parentElement;
    pre.classList.add('mermaid');
    sources.push(blocks[i].textContent);
    pre.textContent = blocks[i].textContent;
  }

  var lightTheme = {
    theme: 'base',
    themeVariables: {
      fontFamily: 'Inter, system-ui, sans-serif',
      primaryColor: '#dbeafe',
      primaryTextColor: '#1e293b',
      primaryBorderColor: '#93c5fd',
      secondaryColor: '#f1f5f9',
      secondaryTextColor: '#334155',
      secondaryBorderColor: '#cbd5e1',
      tertiaryColor: '#e0e7ff',
      tertiaryTextColor: '#334155',
      tertiaryBorderColor: '#a5b4fc',
      lineColor: '#94a3b8',
      textColor: '#334155',
      mainBkg: '#dbeafe',
      nodeBorder: '#93c5fd',
      clusterBkg: '#f8fafc',
      clusterBorder: '#e2e8f0',
      edgeLabelBackground: '#ffffff',
      /* sequence diagram */
      actorBkg: '#dbeafe',
      actorBorder: '#93c5fd',
      actorTextColor: '#1e293b',
      activationBorderColor: '#93c5fd',
      activationBkgColor: '#eff6ff',
      sequenceNumberColor: '#ffffff',
      signalColor: '#334155',
      signalTextColor: '#334155',
      labelBoxBkgColor: '#dbeafe',
      labelBoxBorderColor: '#93c5fd',
      labelTextColor: '#1e293b',
      loopTextColor: '#334155',
      noteBkgColor: '#fef9c3',
      noteBorderColor: '#facc15',
      noteTextColor: '#713f12',
      /* journey diagram */
      fillType0: '#dbeafe',
      fillType1: '#e0e7ff',
      fillType2: '#f1f5f9',
      fillType3: '#fef9c3',
      fillType4: '#dcfce7',
      fillType5: '#fce7f3',
      fillType6: '#ffedd5',
      fillType7: '#f3e8ff',
      /* pie chart */
      pie1: '#3b82f6',
      pie2: '#8b5cf6',
      pie3: '#06b6d4',
      pie4: '#10b981',
      pie5: '#f59e0b',
      pie6: '#ef4444',
      pie7: '#ec4899',
      pie8: '#6366f1',
      pieStrokeColor: '#e2e8f0',
      pieSectionTextColor: '#ffffff',
      pieTitleTextColor: '#1e293b',
      pieStrokeWidth: '1px',
      pieOuterStrokeColor: '#e2e8f0',
      pieLegendTextColor: '#334155',
      /* gantt chart */
      todayLineColor: '#2563eb',
      gridColor: '#e2e8f0',
      doneTaskBkgColor: '#93c5fd',
      doneTaskBorderColor: '#3b82f6',
      activeTaskBkgColor: '#dbeafe',
      activeTaskBorderColor: '#3b82f6',
      critBkgColor: '#fee2e2',
      critBorderColor: '#ef4444',
      taskTextColor: '#1e293b',
      taskTextDarkColor: '#1e293b',
      sectionBkgColor: '#f1f5f9',
      altSectionBkgColor: '#e2e8f0',
      sectionBkgColor2: '#dbeafe',
      taskBkgColor: '#bfdbfe',
      taskBorderColor: '#60a5fa'
    }
  };

  var darkTheme = {
    theme: 'base',
    themeVariables: {
      fontFamily: 'Inter, system-ui, sans-serif',
      primaryColor: '#1e3a5f',
      primaryTextColor: '#e2e8f0',
      primaryBorderColor: '#2563eb',
      secondaryColor: '#1e293b',
      secondaryTextColor: '#cbd5e1',
      secondaryBorderColor: '#334155',
      tertiaryColor: '#312e81',
      tertiaryTextColor: '#e2e8f0',
      tertiaryBorderColor: '#4f46e5',
      lineColor: '#475569',
      textColor: '#cbd5e1',
      mainBkg: '#1e3a5f',
      nodeBorder: '#2563eb',
      clusterBkg: '#0f172a',
      clusterBorder: '#1e293b',
      edgeLabelBackground: '#0f172a',
      /* sequence diagram */
      actorBkg: '#1e3a5f',
      actorBorder: '#2563eb',
      actorTextColor: '#e2e8f0',
      activationBorderColor: '#2563eb',
      activationBkgColor: '#1e293b',
      sequenceNumberColor: '#e2e8f0',
      signalColor: '#cbd5e1',
      signalTextColor: '#cbd5e1',
      labelBoxBkgColor: '#1e3a5f',
      labelBoxBorderColor: '#2563eb',
      labelTextColor: '#e2e8f0',
      loopTextColor: '#cbd5e1',
      noteBkgColor: '#422006',
      noteBorderColor: '#a16207',
      noteTextColor: '#fef9c3',
      /* journey diagram */
      fillType0: '#1e3a5f',
      fillType1: '#312e81',
      fillType2: '#1e293b',
      fillType3: '#422006',
      fillType4: '#14532d',
      fillType5: '#831843',
      fillType6: '#7c2d12',
      fillType7: '#3b0764',
      /* pie chart */
      pie1: '#3b82f6',
      pie2: '#8b5cf6',
      pie3: '#06b6d4',
      pie4: '#10b981',
      pie5: '#f59e0b',
      pie6: '#ef4444',
      pie7: '#ec4899',
      pie8: '#6366f1',
      pieStrokeColor: '#334155',
      pieSectionTextColor: '#e2e8f0',
      pieTitleTextColor: '#e2e8f0',
      pieStrokeWidth: '1px',
      pieOuterStrokeColor: '#334155',
      pieLegendTextColor: '#cbd5e1',
      /* gantt chart */
      todayLineColor: '#3b82f6',
      gridColor: '#334155',
      doneTaskBkgColor: '#1e3a5f',
      doneTaskBorderColor: '#2563eb',
      activeTaskBkgColor: '#312e81',
      activeTaskBorderColor: '#4f46e5',
      critBkgColor: '#7f1d1d',
      critBorderColor: '#ef4444',
      taskTextColor: '#e2e8f0',
      taskTextDarkColor: '#e2e8f0',
      sectionBkgColor: '#1e293b',
      altSectionBkgColor: '#0f172a',
      sectionBkgColor2: '#1e3a5f',
      taskBkgColor: '#1e3a5f',
      taskBorderColor: '#2563eb'
    }
  };

  import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs').then(function (m) {
    var mermaid = m.default;
    function isDark() { return document.documentElement.classList.contains('dark'); }
    function initMermaid() {
      mermaid.initialize(Object.assign({ startOnLoad: false }, isDark() ? darkTheme : lightTheme));
      var els = document.querySelectorAll('pre.mermaid');
      for (var j = 0; j < els.length; j++) {
        els[j].removeAttribute('data-processed');
        els[j].textContent = sources[j];
      }
      mermaid.run({ nodes: els });
    }
    initMermaid();
    new MutationObserver(function (mutations) {
      for (var k = 0; k < mutations.length; k++) {
        if (mutations[k].attributeName === 'class') { initMermaid(); return; }
      }
    }).observe(document.documentElement, { attributes: true });
  });
})();
