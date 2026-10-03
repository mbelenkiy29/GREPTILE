/** Props that make an element an item of a DropdownMenu: `role="menuitem"`, roving focus, and the item style. */
export function menuItemProps(className = "menu-item") {
  return { role: "menuitem" as const, tabIndex: -1, className };
}
