/**
 * Copyright (c) 2013-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule DraftEditorBlock.react
 * @typechecks
 * @flow
 */

'use strict';

const ContentBlock = require('ContentBlock');
const ContentState = require('ContentState');
const DraftEditorLeaf = require('DraftEditorLeaf.react');
const DraftOffsetKey = require('DraftOffsetKey');
const React = require('React');
const ReactDOM = require('ReactDOM');
const Scroll = require('Scroll');
const SelectionState = require('SelectionState');
const Style = require('Style');
const UnicodeBidi = require('UnicodeBidi');
const UnicodeBidiDirection = require('UnicodeBidiDirection');

const cx = require('cx');
const getElementPosition = require('getElementPosition');
const getScrollPosition = require('getScrollPosition');
const getViewportDimensions = require('getViewportDimensions');
const nullthrows = require('nullthrows');

import type {BidiDirection} from 'UnicodeBidiDirection';
import type {DraftDecoratorType} from 'DraftDecoratorType';
import type {List} from 'immutable';

const SCROLL_BUFFER = 10;

type Props = {
  contentState: ContentState,
  block: ContentBlock,
  customStyleMap: Object,
  customStyleFn: Function,
  tree: List<any>,
  selection: SelectionState,
  decorator: DraftDecoratorType,
  forceSelection: boolean,
  direction: BidiDirection,
  blockProps?: Object,
  readOnly:boolean,
  startIndent?: boolean,
  blockStyleFn: Function,
  textAlign:string,
};

/**
 * The default block renderer for a `DraftEditor` component.
 *
 * A `DraftEditorBlock` is able to render a given `ContentBlock` to its
 * appropriate decorator and inline style components.
 */
class DraftEditorBlock extends React.Component {
  shouldComponentUpdate(nextProps: Props): boolean {
    var updateTailCR = (cp,np)=>{
      var curEditing = cp.selection.getHasFocus() && cp.selection.isCollapsed() && cp.selection.getStartKey() === cp.block.getKey();
      var nextEditing = np.selection.getHasFocus()  && np.selection.isCollapsed() && np.selection.getStartKey() === np.block.getKey();
      return curEditing != nextEditing;
    };
    return (
        this.props.textAlign != nextProps.textAlign ||
        this.props.readOnly != nextProps.readOnly ||
      this.props.block !== nextProps.block ||
      this.props.tree !== nextProps.tree ||
      updateTailCR(this.props, nextProps)||
      this.props.direction !== nextProps.direction ||
      (
        isBlockOnSelectionEdge(
          nextProps.selection,
          nextProps.block.getKey()
        ) &&
        nextProps.forceSelection
      )
    );
  }

  /**
   * When a block is mounted and overlaps the selection state, we need to make
   * sure that the cursor is visible to match native behavior. This may not
   * be the case if the user has pressed `RETURN` or pasted some content, since
   * programatically creating these new blocks and setting the DOM selection
   * will miss out on the browser natively scrolling to that position.
   *
   * To replicate native behavior, if the block overlaps the selection state
   * on mount, force the scroll position. Check the scroll state of the scroll
   * parent, and adjust it to align the entire block to the bottom of the
   * scroll parent.
   */
  componentDidMount(): void {
    var selection = this.props.selection;
    var endKey = selection.getEndKey();
    if (!selection.getHasFocus() || endKey !== this.props.block.getKey()) {
      return;
    }

    var blockNode = ReactDOM.findDOMNode(this);
    var scrollParent = Style.getScrollParent(blockNode);
    var scrollPosition = getScrollPosition(scrollParent);
    var scrollDelta;

    if (scrollParent === window) {
      var nodePosition = getElementPosition(blockNode);
      var nodeBottom = nodePosition.y + nodePosition.height;
      var viewportHeight = getViewportDimensions().height;
      scrollDelta = nodeBottom - viewportHeight;
      if (scrollDelta > 0) {
        window.scrollTo(
          scrollPosition.x,
          scrollPosition.y + scrollDelta + SCROLL_BUFFER
        );
      }
    } else {
      var blockBottom = blockNode.offsetHeight + blockNode.offsetTop;
      var scrollBottom = scrollParent.offsetHeight + scrollPosition.y;
      scrollDelta = blockBottom - scrollBottom;
      if (scrollDelta > 0) {
        Scroll.setTop(
          scrollParent,
          Scroll.getTop(scrollParent) + scrollDelta + SCROLL_BUFFER
        );
      }
    }
  }

  _renderChildren(): Array<React.Element<any>> {
    var block = this.props.block;
    var blockKey = block.getKey();
    var text = block.getText();
    var lastLeafSet = this.props.tree.size - 1;
    var hasSelection = isBlockOnSelectionEdge(this.props.selection, blockKey);

    return this.props.tree.map((leafSet, ii) => {
      var leavesForLeafSet = leafSet.get('leaves');
      var lastLeaf = leavesForLeafSet.size - 1;
      var leaves = leavesForLeafSet.map((leaf, jj) => {
        var offsetKey = DraftOffsetKey.encode(blockKey, ii, jj);
        var start = leaf.get('start');
        var end = leaf.get('end');
        return (
          <DraftEditorLeaf
            key={offsetKey}
            offsetKey={offsetKey}
            blockKey={blockKey}
            start={start}
            textAlign={this.props.textAlign}
            //if caret in current empty line, a 'android center handle' may overlay the caret
            isEditing={this.props.selection.getHasFocus() && this.props.selection.isCollapsed() && this.props.selection.getStartKey() === blockKey}
            isEmpty={text.length == 0 && !this.props.readOnly}
            readOnly={this.props.readOnly}
            selection={hasSelection ? this.props.selection : undefined}
            forceSelection={this.props.forceSelection}
            text={text.slice(start, end)}
            styleSet={block.getInlineStyleAt(start)}
            customStyleMap={this.props.customStyleMap}
            customStyleFn={this.props.customStyleFn}
            isLast={ii === lastLeafSet && jj === lastLeaf}
          />
        );
      }).toArray();

      var decoratorKey = leafSet.get('decoratorKey');
      if (decoratorKey == null) {
        return leaves;
      }

      if (!this.props.decorator) {
        return leaves;
      }

      var decorator = nullthrows(this.props.decorator);

      var DecoratorComponent = decorator.getComponentForKey(decoratorKey);
      if (!DecoratorComponent) {
        return leaves;
      }

      var decoratorProps = decorator.getPropsForKey(decoratorKey);
      var decoratorOffsetKey = DraftOffsetKey.encode(blockKey, ii, 0);
      var decoratedText = text.slice(
        leavesForLeafSet.first().get('start'),
        leavesForLeafSet.last().get('end')
      );

      // Resetting dir to the same value on a child node makes Chrome/Firefox
      // confused on cursor movement. See http://jsfiddle.net/d157kLck/3/
      var dir = UnicodeBidiDirection.getHTMLDirIfDifferent(
        UnicodeBidi.getDirection(decoratedText),
        this.props.direction,
      );

      return (
        <DecoratorComponent
          {...decoratorProps}
          contentState={this.props.contentState}
          decoratedText={decoratedText}
          dir={dir}
          key={decoratorOffsetKey}
          entityKey={block.getEntityAt(leafSet.get('start'))}
          offsetKey={decoratorOffsetKey}>
          {leaves}
        </DecoratorComponent>
      );
    }).toArray();
  }

  render(): React.Element<any> {
    const {direction, offsetKey} = this.props;
    const className = cx({
      'public/DraftStyleDefault/block': true,
      'public/DraftStyleDefault/ltr': direction === 'LTR',
      'public/DraftStyleDefault/rtl': direction === 'RTL',
    });

    return (
      <div data-offset-key={offsetKey} className={className}>
        {this._renderChildren()}
      </div>
    );
  }
}

/**
 * Return whether a block overlaps with either edge of the `SelectionState`.
 */
function isBlockOnSelectionEdge(
  selection: SelectionState,
  key: string
): boolean {
  return (
    selection.getAnchorKey() === key ||
    selection.getFocusKey() === key
  );
}

module.exports = DraftEditorBlock;
