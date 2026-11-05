import { ToolBoxElement } from './ToolBoxElement';

export class ToolBox {
    private readonly holder: HTMLElement;

    /**
     * @param list elements of the tool box
     * @param holder optional pre-built holder. When provided, the caller is
     * responsible for placing the elements inside it (e.g. a floating dock with
     * its own layout); otherwise all elements are appended to a plain list.
     */
    constructor(list: ToolBoxElement<any>[], holder?: HTMLElement) {
        if (holder) {
            this.holder = holder;
            return;
        }
        this.holder = document.createElement('div');
        this.holder.classList.add('control-buttons-list', 'control-wrapper');
        list.forEach((item) => {
            item.getAllElements().forEach((el) => {
                this.holder.appendChild(el);
            });
        });
    }

    public getHolderElement(): HTMLElement {
        return this.holder;
    }
}
