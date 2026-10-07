import styles from './Layout.module.css';

/** Logo : la lune, l'horizon et deux traits de reflet (décoratif, le nom est écrit à côté). */
export function BrandMark() {
  return (
    <svg className={styles.brandMark} viewBox="0 0 28 28" fill="none" aria-hidden="true" focusable="false">
      <path className={styles.brandMarkMoon} d="M16 3a6 6 0 1 0 5 9.3A5 5 0 0 1 16 3z" />
      <path className={styles.brandMarkLine} d="M3 17.5h22" strokeWidth="1.4" strokeLinecap="round" />
      <path className={styles.brandMarkReflect} d="M8 21.5h12M11 25h6" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
