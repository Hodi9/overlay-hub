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

  return { fontFor: fontFor };
})();
