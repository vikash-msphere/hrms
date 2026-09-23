import { forwardRef } from "react";
import type { LucideProps } from "lucide-react";

// Rupee-in-a-circle glyph (Material Symbols). Typed as a lucide icon so it drops into any nav/EmptyState/icon
// slot. Unlike lucide's outline icons (stroke=currentColor), this is a FILLED glyph, so it paints with
// fill="currentColor" and inherits the surrounding text colour. Sizing comes from the className (h-4 w-4 …).
export const RupeeCircle = forwardRef<SVGSVGElement, LucideProps>(({ size = 24, className, ...props }, ref) => (
  <svg
    ref={ref}
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 -960 960 960"
    width={size}
    height={size}
    fill="currentColor"
    className={className}
    aria-hidden="true"
    {...props}
  >
    <path d="M531-260h96v-3L462-438l1-3h10q54 0 89.5-33t43.5-77h40v-47h-41q-3-15-10.5-28.5T576-653h70v-47H314v57h156q26 0 42.5 13t22.5 32H314v47h222q-6 20-23 34.5T467-502H367v64l164 178ZM480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z" />
  </svg>
));
RupeeCircle.displayName = "RupeeCircle";
