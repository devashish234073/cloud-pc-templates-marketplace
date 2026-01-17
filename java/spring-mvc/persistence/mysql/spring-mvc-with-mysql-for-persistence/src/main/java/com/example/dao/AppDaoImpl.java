package com.example.dao;

import com.example.model.Item;
import org.hibernate.Session;
import org.hibernate.SessionFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public class AppDaoImpl implements AppDao {

    @Autowired
    private SessionFactory sessionFactory;

    @Override
    public List<Item> getItems() {
        Session session = sessionFactory.getCurrentSession();
        return session.createQuery("from Item", Item.class).list();
    }

    @Override
    public void saveItem(Item item) {
        Session session = sessionFactory.getCurrentSession();
        session.saveOrUpdate(item);
    }
}
