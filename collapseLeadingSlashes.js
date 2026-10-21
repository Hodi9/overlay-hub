// Et link med dobbelt skråstreg forrest ("https://site.com//sti") virker som med ét.
// Skal ligge allerførst i serveren, så alt efter ser den rene sti.
export function collapseLeadingSlashes(req, _res, next) {
  if (req.url.startsWith("//")) req.url = req.url.replace(/^\/{2,}/, "/");
  next();
}
