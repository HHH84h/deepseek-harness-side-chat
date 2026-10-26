window.__ModuleLoader__.load({
  id: 'side-chat-browser-driver',
  factory() {
    const inject = ['sessions', 'workspaces', 'uiWorkspace', 'commandUi', 'sidebarRight', 'remote', 'remote.commands', 'remote.pluginManager'];
    function apply(ctx) {
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      window.__SIDE_ACCEPTANCE__ = {
        async create(cwd) {
          const workspace = await ctx.workspaces.create({ path: cwd });
          await ctx.workspaces.rename(workspace.workspaceId, '演示工作区');
          const mainId = await ctx.sessions.create({ workspaceId: workspace.workspaceId });
          ctx.uiWorkspace.openSession(mainId);
          return mainId;
        },
        async send(id, text) {
          return ctx.sessions.using(id, { source: 'workspaceOperation' }, async ref => {
            await ref.ready;
            const result = await ref.binding.session.prompt([{ type: 'text', text }], 'queue');
            if (!result.ok) throw new Error('test prompt refused');
            await sleep(600);
            for (let i = 0; i < 120 && ref.binding.session.getSnapshot().running; i++) await sleep(100);
            return !ref.binding.session.getSnapshot().running;
          });
        },
        async side(mainId) { return ctx.commandUi.execute({ sessionId: mainId }, '/side', []); },
        binding(mainId) { return ctx.sessions.list.getSnapshot().projectionsBySession?.[mainId]?.values?.sideChatBinding?.sideId; },
        async close(mainId) {
          const tabs = ctx.sidebarRight.tabsIn(mainId);
          const tab = tabs.find(t => t.contentId?.startsWith('dsh-resource://sidechat/session/'));
          if (!tab) throw new Error('test side tab missing');
          ctx.sidebarRight.close(tab.id);
          return true;
        },
        async bundleList() { return ctx.remote.pluginManager.listBundles(); },
        async bundleInspect(spec) { return ctx.remote.pluginManager.inspect(spec, {}); },
        async bundleInstall(spec) { return ctx.remote.pluginManager.installBundle(spec, { enabled: true }); },
        async bundleEnable(enabled) { return ctx.remote.pluginManager.setBundleEnabled('dsh-client-ui-side', enabled); },
        async bundleRemove() { return ctx.remote.pluginManager.removeBundle('dsh-client-ui-side'); },
        async sideFlag(mainId, flag, sideId) { return ctx.remote.commands.execute(mainId, `/side ${flag} ${sideId}`, []); },
        state() { return { sessions: ctx.sessions.list.getSnapshot(), workspaces: ctx.workspaces.list.getSnapshot() }; },
      };
      ctx.effect(() => () => { delete window.__SIDE_ACCEPTANCE__; }, 'browser test lifetime');
    }
    return { inject, apply };
  },
});
