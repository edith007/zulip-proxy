window.main = (() => {
    const pane_config = [
        {
            label: 'Tic Tac Toe',
            view: () => window.tictactoe.render(),
        },
        {
            label: 'Users',
            view: () => window.users.render(),
        },
        {
            label: 'Messages',
            view: () => window.messages.render(),
        },
        {
            label: 'Streams',
            view: () => window.streams.render(),
        },
    ];

    const main_pane_widget = window.split_pane.make(pane_config);

    function make(redraw_callback) {
        async function render() {
            const top_div = $('<div>');
            top_div.text(`${_.me().full_name} - `);
            const link = $('<a>', {
                text: `Server: ${model().state.server}`,
                href: model().state.server,
            });
            top_div.append(link);

            const redraw_button = $('<button>').text('redraw app');

            redraw_button.on('click', redraw_callback);

            const main_pane = await main_pane_widget.render();

            const page = $('<div>');
            page.append($('<div>').html(redraw_button));
            page.append(top_div);
            page.append('<hr>');

            page.append(main_pane);

            return page;
        }

        return {
            render: render,
        };
    }

    return {
        make: make,
    };
})();
