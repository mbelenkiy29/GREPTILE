import { slugify } from "../util/slug";

export interface Post {
  title: string;
  slug: string;
}

export function createPost(title: string): Post {
  return { title: title.trim(), slug: slugify(title) };
}
