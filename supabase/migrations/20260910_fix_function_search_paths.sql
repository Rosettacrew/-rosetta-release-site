-- Pin helper-function resolution so callers cannot influence object lookup.
alter function public.release_artwork_ready_for_storefront(text, text)
  set search_path = '';

alter function public.release_products_artwork_publish_guard()
  set search_path = '';
