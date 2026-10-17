import '@testing-library/jest-dom';
import { configure } from '@testing-library/react';

// findBy*/waitFor give up after 1 s by default. Dialogs and popovers here are
// React.lazy chunks, and the first import of one can take longer than that
// while ~50 test files transform in parallel, which failed tests that pass
// alone (sidebar-nesting, trash-dialog). A longer ceiling costs nothing when
// the element appears quickly.
configure({ asyncUtilTimeout: 5000 });
