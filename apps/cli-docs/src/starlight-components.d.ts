// Header.astro follows Starlight's own header and imports these components
// through Starlight's virtual modules, so a component override in
// astro.config.mjs still applies. Starlight does not declare these modules
// in its public types.
declare module "virtual:starlight/components/Search" {
  const Search: typeof import("@astrojs/starlight/components/Search.astro").default;
  export default Search;
}
declare module "virtual:starlight/components/SiteTitle" {
  const SiteTitle: typeof import("@astrojs/starlight/components/SiteTitle.astro").default;
  export default SiteTitle;
}
declare module "virtual:starlight/components/SocialIcons" {
  const SocialIcons: typeof import("@astrojs/starlight/components/SocialIcons.astro").default;
  export default SocialIcons;
}
