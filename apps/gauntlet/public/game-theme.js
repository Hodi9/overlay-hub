window.GauntletTheme = (function(){
  var FONT_BY_ID = {
    fortnite: "'Bungee', cursive",
    warzone: "'Black Ops One', cursive",
    minecraft: "'Press Start 2P', monospace",
    lol: "'Cinzel', serif",
    rocketleague: "'Bebas Neue', sans-serif"
  };
  var FONT_BY_NAME = {
    'fortnite': FONT_BY_ID.fortnite,
    'warzone': FONT_BY_ID.warzone,
    'call of duty': FONT_BY_ID.warzone,
    'minecraft': FONT_BY_ID.minecraft,
    'league of legends': FONT_BY_ID.lol,
    'rocket league': FONT_BY_ID.rocketleague
  };

  function fontFor(game){
    var byId = FONT_BY_ID[game.id];
    if (byId) return byId;
    return FONT_BY_NAME[String(game.name || '').trim().toLowerCase()] || null;
  }

  var LOGO_BY_ID = {
    fortnite: 'assets/logos/fortnite.png',
    warzone: 'assets/logos/warzone.png',
    minecraft: 'assets/logos/minecraft.png',
    lol: 'assets/logos/lol.png',
    rocketleague: 'assets/logos/rocketleague.png'
  };
  var LOGO_BY_NAME = {
    'fortnite': LOGO_BY_ID.fortnite,
    'warzone': LOGO_BY_ID.warzone,
    'call of duty': LOGO_BY_ID.warzone,
    'minecraft': LOGO_BY_ID.minecraft,
    'league of legends': LOGO_BY_ID.lol,
    'rocket league': LOGO_BY_ID.rocketleague
  };

  function logoFor(game){
    var byId = LOGO_BY_ID[game.id];
    if (byId) return byId;
    return LOGO_BY_NAME[String(game.name || '').trim().toLowerCase()] || null;
  }

  function classFor(game){
    var id = String(game.id || '').trim().toLowerCase();
    if (FONT_BY_ID[id]) return id;
    var name = String(game.name || '').trim().toLowerCase();
    if (name === 'league of legends') return 'lol';
    if (name === 'rocket league') return 'rocketleague';
    if (name.indexOf('warzone') !== -1 || name.indexOf('call of duty') !== -1) return 'warzone';
    if (name === 'fortnite' || name === 'minecraft') return name;
    return 'generic';
  }

  return { fontFor: fontFor, logoFor: logoFor, classFor: classFor };
})();
